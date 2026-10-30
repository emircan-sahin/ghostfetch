import fs from 'node:fs';
import http2 from 'node:http2';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { GhostFetch } from '../src';

/**
 * Kept connections, against a real HTTP/2 server. CycleTLS 2.0.5 cached the first TLS connection per
 * host and handed it back on every dial after it closed: one closed connection (a server or proxy
 * dropping it, the network going away) failed that host for good with "use of closed network
 * connection". Measured 2026-10-30: 35 of a backend's proxy routes to one host broke after a laptop
 * slept, and each healed only when the same proxy happened to carry a request to another host.
 */

// Self-signed for localhost, valid until 2036 (tests/fixtures).
const fixtures = path.join(import.meta.dirname, 'fixtures');
const sessions = new Set<http2.ServerHttp2Session>();
let sessionsOpened = 0;

const server = http2.createSecureServer(
  { key: fs.readFileSync(path.join(fixtures, 'key.pem')), cert: fs.readFileSync(path.join(fixtures, 'cert.pem')) },
  (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  },
);
server.on('session', (session) => {
  sessionsOpened++;
  sessions.add(session);
  session.on('close', () => sessions.delete(session));
});

let url: string;
let client: GhostFetch;

/** Close every connection the server holds, as a proxy or a server timing them out would. */
async function dropConnections() {
  for (const session of sessions) session.destroy();
  await new Promise((resolve) => setTimeout(resolve, 200));
}

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `https://localhost:${(server.address() as AddressInfo).port}/`;
  client = new GhostFetch({ insecureSkipVerify: true, retry: { delays: [] } });
  // A CycleTLS process of its own: on the shared port the test would ride whatever Go process
  // another program on this machine (a running backend) left there, with that program's binary.
  (client as unknown as { usePrivatePort: boolean }).usePrivatePort = true;
});

afterAll(async () => {
  await client.destroy();
  await new Promise((resolve) => server.close(resolve));
});

describe('connection reuse', () => {
  it('keeps one connection for consecutive requests', async () => {
    const before = sessionsOpened;
    for (let i = 0; i < 4; i++) expect((await client.get(url)).status).toBe(200);
    expect(sessionsOpened - before).toBe(1);
  });

  it('opens a new connection once the kept one closes', async () => {
    await client.get(url);
    await dropConnections();

    // No retry is allowed (`delays: []`): each request must get through on its own.
    for (let i = 0; i < 3; i++) expect((await client.get(url)).status).toBe(200);
  });

  it('recovers again after a second close', async () => {
    await dropConnections();
    expect((await client.get(url)).status).toBe(200);
    await dropConnections();
    expect((await client.get(url)).status).toBe(200);
  });
});
