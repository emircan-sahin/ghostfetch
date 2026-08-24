import http from 'node:http';
import { AddressInfo } from 'node:net';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { GhostFetch } from '../src';

/**
 * CycleTLS shares one Go subprocess per port and tears it down when the last client
 * leaves — asynchronously, and it only drops the registry entry afterwards. An init
 * that lands in that window used to stall for CycleTLS' full 20s connect timeout, or
 * inherit an instance pointing at nothing. These guard the recovery paths.
 */

let port: number;
const server = http.createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end('{"ok":true}');
});

const url = () => `http://127.0.0.1:${port}/`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  port = (server.address() as AddressInfo).port;
});

afterAll(() => server.close());

describe('transport lifecycle', () => {
  it('survives destroy-then-recreate without stalling', async () => {
    const elapsed: number[] = [];

    for (let i = 0; i < 3; i++) {
      const client = new GhostFetch({ retry: { delays: [] } });
      const started = Date.now();

      const res = await client.get(url());
      elapsed.push(Date.now() - started);

      expect(res.status).toBe(200);
      await client.destroy();
    }

    // Re-initializing immediately after a teardown used to burn CycleTLS' 20s connect
    // timeout on a port that was still lingering
    for (const ms of elapsed) expect(ms).toBeLessThan(5000);
  }, 60000);

  it('reopens the transport after an idle shutdown', async () => {
    const client = new GhostFetch({ retry: { delays: [] }, idleTimeout: 300 });

    const first = await client.get(url());
    expect(first.status).toBe(200);

    await sleep(900); // let the idle timer close the transport

    const started = Date.now();
    const second = await client.get(url());

    expect(second.status).toBe(200);
    expect(Date.now() - started).toBeLessThan(5000);

    await client.destroy();
  }, 60000);

  it('two clients can work at the same time', async () => {
    const a = new GhostFetch({ retry: { delays: [] } });
    const b = new GhostFetch({ retry: { delays: [] } });

    const [ra, rb] = await Promise.all([a.get(url()), b.get(url())]);
    expect(ra.status).toBe(200);
    expect(rb.status).toBe(200);

    // One client shutting down must not break the other
    await a.destroy();
    expect((await b.get(url())).status).toBe(200);

    await b.destroy();
  }, 60000);

  it('destroy is safe to call twice', async () => {
    const client = new GhostFetch({ retry: { delays: [] } });
    await client.get(url());

    await client.destroy();
    await expect(client.destroy()).resolves.toBeUndefined();
  }, 30000);
});
