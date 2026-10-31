import http from 'node:http';
import { execSync } from 'node:child_process';
import { AddressInfo } from 'node:net';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { GhostFetch } from '../src';

/**
 * The CycleTLS Go process can die under us (a crash, an OOM kill). Every request in flight then
 * has to come back on a rebuilt transport rather than wait out its timeout, and a burst that
 * fails together must not close the transport the first of them rebuilt.
 */

let port: number;
const server = http.createServer((req, res) => {
  const delay = req.url === '/slow' ? 1500 : 0;
  setTimeout(() => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  }, delay);
});

beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  port = (server.address() as AddressInfo).port;
});

afterAll(() => {
  server.closeAllConnections();
  server.close();
});

/** The Go servers this process spawned (CycleTLS runs them as its direct children). */
function goChildren(): number[] {
  const out = execSync(`pgrep -P ${process.pid} || true`).toString().trim();
  return out ? out.split('\n').map(Number) : [];
}

describe('a Go process that dies', () => {
  it('brings a burst in flight back on one rebuilt transport', async () => {
    const client = new GhostFetch({ healthCheck: false, timeout: 10_000, retry: { delays: [] } });
    try {
      await client.get(`http://127.0.0.1:${port}/warm`);
      const before = goChildren();
      expect(before.length).toBeGreaterThan(0);

      const burst = Array.from({ length: 20 }, () => client.get(`http://127.0.0.1:${port}/slow`));
      await new Promise((r) => setTimeout(r, 300));
      const started = Date.now();
      for (const pid of before) process.kill(pid, 'SIGKILL');

      const responses = await Promise.all(burst);
      expect(responses.every((response) => response.status === 200)).toBe(true);
      // Back on the rebuilt transport: the slow answer again, not a 10s timeout.
      expect(Date.now() - started).toBeLessThan(5000);

      const after = goChildren().filter((pid) => !before.includes(pid));
      expect(after).toHaveLength(1);
      expect((await client.get(`http://127.0.0.1:${port}/after`)).status).toBe(200);
    } finally {
      await client.destroy();
    }
  }, 30_000);
});

describe('a failure reported late by the old transport', () => {
  it('does not close the transport that replaced it', async () => {
    const client = new GhostFetch({ healthCheck: false, timeout: 10_000 });
    type Internals = {
      ensureClient: () => Promise<unknown>;
      closeTransport: (expected?: unknown) => Promise<void>;
    };
    const internals = client as unknown as Internals;
    try {
      const old = await internals.ensureClient();
      await internals.closeTransport(old);
      const rebuilt = await internals.ensureClient();

      // A request still holding the old client fails after the rebuild landed.
      await internals.closeTransport(old);

      expect(await internals.ensureClient()).toBe(rebuilt);
      expect((await client.get(`http://127.0.0.1:${port}/after`)).status).toBe(200);
    } finally {
      await client.destroy();
    }
  }, 30_000);
});
