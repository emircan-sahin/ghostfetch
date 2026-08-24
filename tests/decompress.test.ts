import zlib from 'node:zlib';
import { describe, it, expect } from 'vitest';
import { decompress, SUPPORTED_ENCODINGS, DEFAULT_MAX_DECOMPRESSED_SIZE } from '../src/decompress';

const PAYLOAD = JSON.stringify({ hello: 'world', n: 12345678901234567890n.toString() });
const raw = Buffer.from(PAYLOAD);

describe('decompress', () => {
  it('passes the body through when there is no content-encoding', async () => {
    expect((await decompress(raw, undefined)).toString()).toBe(PAYLOAD);
    expect((await decompress(raw, 'identity')).toString()).toBe(PAYLOAD);
  });

  it('decodes gzip', async () => {
    expect((await decompress(zlib.gzipSync(raw), 'gzip')).toString()).toBe(PAYLOAD);
  });

  it('decodes brotli', async () => {
    expect((await decompress(zlib.brotliCompressSync(raw), 'br')).toString()).toBe(PAYLOAD);
  });

  it('decodes both flavours of deflate', async () => {
    expect((await decompress(zlib.deflateSync(raw), 'deflate')).toString()).toBe(PAYLOAD);
    expect((await decompress(zlib.deflateRawSync(raw), 'deflate')).toString()).toBe(PAYLOAD);
  });

  it('is case- and whitespace-insensitive', async () => {
    expect((await decompress(zlib.gzipSync(raw), '  GZIP ')).toString()).toBe(PAYLOAD);
  });

  it('undoes stacked codings in reverse order', async () => {
    const doubled = zlib.gzipSync(zlib.brotliCompressSync(raw));
    expect((await decompress(doubled, 'br, gzip')).toString()).toBe(PAYLOAD);
  });

  it('returns the original bytes rather than throwing on corrupt data', async () => {
    const notGzip = Buffer.from('plain text');
    expect((await decompress(notGzip, 'gzip')).toString()).toBe('plain text');
  });

  it('returns the original bytes for an unknown coding', async () => {
    expect((await decompress(raw, 'magic-v9')).toString()).toBe(PAYLOAD);
  });

  it('handles an empty body', async () => {
    expect((await decompress(Buffer.alloc(0), 'gzip')).length).toBe(0);
  });

  it('only advertises codings it can actually decode', () => {
    expect(SUPPORTED_ENCODINGS).toContain('gzip');
    expect(SUPPORTED_ENCODINGS).toContain('br');
    expect(SUPPORTED_ENCODINGS).toContain('deflate');
    const hasZstd = typeof (zlib as { zstdDecompress?: unknown }).zstdDecompress === 'function';
    expect(SUPPORTED_ENCODINGS.includes('zstd')).toBe(hasZstd);
  });
});


describe('decompress — size limit', () => {
  it('refuses a bomb: a tiny body that expands far past the limit', async () => {
    // 4MB of one repeated byte compresses to a few KB — the shape of a real bomb,
    // kept small enough that the test itself does not hoard memory
    const bomb = zlib.gzipSync(Buffer.alloc(4 * 1024 * 1024, 0x41));
    expect(bomb.length).toBeLessThan(50_000);

    await expect(decompress(bomb, 'gzip', 64 * 1024)).rejects.toThrow(/exceeds the .* byte limit/);
  }, 30000);

  it('reports the limit and the encoding in the error', async () => {
    const body = zlib.gzipSync(Buffer.alloc(4096, 0x41));
    await expect(decompress(body, 'gzip', 1024)).rejects.toThrow(/exceeds the 1024 byte limit/);
    await expect(decompress(body, 'gzip', 1024)).rejects.toThrow(/content-encoding: gzip/);
  });

  it('lets anything under the limit through', async () => {
    const body = zlib.gzipSync(Buffer.alloc(4096, 0x41));
    await expect(decompress(body, 'gzip', 8192)).resolves.toHaveLength(4096);
  });

  it('applies the limit to every coding, not just gzip', async () => {
    const payload = Buffer.alloc(4096, 0x41);

    await expect(decompress(zlib.brotliCompressSync(payload), 'br', 1024)).rejects.toThrow(/byte limit/);
    await expect(decompress(zlib.deflateSync(payload), 'deflate', 1024)).rejects.toThrow(/byte limit/);
  });

  it('defaults to a limit that real responses stay under', async () => {
    expect(DEFAULT_MAX_DECOMPRESSED_SIZE).toBe(100 * 1024 * 1024);

    const ordinary = zlib.gzipSync(Buffer.alloc(512 * 1024, 0x41));
    await expect(decompress(ordinary, 'gzip')).resolves.toHaveLength(512 * 1024);
  });
});
