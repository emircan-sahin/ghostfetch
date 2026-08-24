import zlib from 'node:zlib';
import { promisify } from 'node:util';

/**
 * Response body decompression.
 *
 * CycleTLS' Go transport decompresses for us *only* while it owns the
 * `Accept-Encoding` header. The moment a caller sets that header themselves — which
 * anyone matching a browser fingerprint must, since every real browser sends it — Go
 * steps back and hands over the raw compressed bytes. So we decode them here.
 */

/**
 * Ceiling on a decompressed body.
 *
 * A few hundred kilobytes of gzip can expand to gigabytes, so an unbounded decode
 * lets any server we scrape take the process down. Node enforces this inside zlib
 * and errors out instead of allocating.
 */
export const DEFAULT_MAX_DECOMPRESSED_SIZE = 100 * 1024 * 1024;

const gunzip = promisify(zlib.gunzip);
const inflate = promisify(zlib.inflate);
const inflateRaw = promisify(zlib.inflateRaw);
const brotli = promisify(zlib.brotliDecompress);

/** zstd landed in Node 22.15 / 23.8 — older runtimes simply cannot decode it. */
const zstd =
  typeof (zlib as { zstdDecompress?: unknown }).zstdDecompress === 'function'
    ? promisify(
        (zlib as unknown as { zstdDecompress: typeof zlib.gunzip }).zstdDecompress,
      )
    : null;

/** Content codings we can actually decode on this runtime, in browser order. */
export const SUPPORTED_ENCODINGS: string[] = ['gzip', 'deflate', 'br', ...(zstd ? ['zstd'] : [])];

/**
 * Decode a body according to its `Content-Encoding`.
 *
 * Multiple codings are listed in the order they were applied, so they are undone in
 * reverse. Anything we cannot decode — an unknown coding, or corrupt data — yields the
 * bytes we already have rather than an exception: a caller inspecting a broken body is
 * better off than one holding an error.
 */
export async function decompress(
  body: Buffer,
  contentEncoding?: string,
  maxSize: number = DEFAULT_MAX_DECOMPRESSED_SIZE,
): Promise<Buffer> {
  if (!contentEncoding || body.length === 0) return body;

  const codings = contentEncoding
    .split(',')
    .map((c) => c.trim().toLowerCase())
    .filter((c) => c && c !== 'identity')
    .reverse();

  let result = body;

  for (const coding of codings) {
    try {
      result = await decode(result, coding, maxSize);
    } catch (err) {
      // Blowing the size limit is an attack, not a quirk — surface it rather than
      // handing back bytes the caller would try to parse
      if (isSizeLimitError(err)) {
        throw new Error(
          `Decompressed response exceeds the ${maxSize} byte limit (content-encoding: ${contentEncoding})`,
        );
      }
      return body;
    }
  }

  return result;
}

async function decode(body: Buffer, coding: string, maxSize: number): Promise<Buffer> {
  const limit = { maxOutputLength: maxSize };

  switch (coding) {
    case 'gzip':
    case 'x-gzip':
      return gunzip(body, limit);
    case 'br':
      return brotli(body, limit);
    case 'zstd':
      if (!zstd) throw new Error('zstd requires Node 22.15+');
      return zstd(body, limit);
    case 'deflate':
      // Servers disagree on whether "deflate" means zlib or raw deflate, so try both
      try {
        return await inflate(body, limit);
      } catch (err) {
        if (isSizeLimitError(err)) throw err;
        return inflateRaw(body, limit);
      }
    default:
      throw new Error(`Unsupported content-encoding: ${coding}`);
  }
}

/** Node reports a breached maxOutputLength with this code. */
function isSizeLimitError(err: unknown): boolean {
  return (err as NodeJS.ErrnoException)?.code === 'ERR_BUFFER_TOO_LARGE';
}
