/**
 * Browser identity presets.
 *
 * Copying a fingerprint out of tls.peet.ws by hand is fiddly and easy to get wrong —
 * the usual mistake is mixing a Chrome JA3 with a Firefox User-Agent, which is a
 * louder detection signal than sending no fingerprint at all. A preset bundles the
 * TLS, HTTP/2 and header-level identity of one browser so they always agree.
 *
 * These are snapshots of a real browser build and will drift as browsers ship new
 * versions. For a site that scrutinises fingerprints closely, still take your own
 * values from https://tls.peet.ws/api/all — anything you set explicitly in the
 * config wins over the preset.
 */

import { SUPPORTED_ENCODINGS } from './decompress';

export type BrowserPreset = 'chrome' | 'firefox';

/**
 * Only advertise codings this Node build can actually decode. Claiming zstd on a
 * runtime without it would earn us a body we cannot read.
 */
const ACCEPT_ENCODING = SUPPORTED_ENCODINGS.join(', ');

export interface BrowserProfile {
  ja3: string;
  http2Fingerprint: string;
  userAgent: string;
  headerOrder: string[];
  headers: Record<string, string>;
}

const CHROME: BrowserProfile = {
  ja3:
    '771,4865-4866-4867-49195-49199-49196-49200-52393-52392-49171-49172-156-157-47-53,' +
    '0-5-10-11-13-16-18-21-23-27-35-43-45-51-17513-65281,29-23-24,0',
  http2Fingerprint: '1:65536;2:0;4:6291456;6:262144|15663105|0|m,a,s,p',
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
    'Chrome/131.0.0.0 Safari/537.36',
  headerOrder: [
    'host',
    'connection',
    'sec-ch-ua',
    'sec-ch-ua-mobile',
    'sec-ch-ua-platform',
    'upgrade-insecure-requests',
    'user-agent',
    'accept',
    'sec-fetch-site',
    'sec-fetch-mode',
    'sec-fetch-user',
    'sec-fetch-dest',
    'accept-encoding',
    'accept-language',
  ],
  headers: {
    'sec-ch-ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'upgrade-insecure-requests': '1',
    accept:
      'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,' +
      'image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
    'sec-fetch-site': 'none',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-user': '?1',
    'sec-fetch-dest': 'document',
    'accept-encoding': ACCEPT_ENCODING,
    'accept-language': 'en-US,en;q=0.9',
  },
};

const FIREFOX: BrowserProfile = {
  ja3:
    '771,4865-4867-4866-49195-49199-52393-52392-49196-49200-49162-49161-49171-49172-51-57-47-53-10,' +
    '0-23-65281-10-11-35-16-5-51-43-13-45-28-21,29-23-24-25-256-257,0',
  http2Fingerprint:
    '1:65536;2:0;4:131072;5:16384|12517377|3:0:0:201,5:0:0:101,7:0:0:1,9:0:7:1,11:0:3:1,13:0:0:241|m,p,a,s',
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0',
  headerOrder: [
    'host',
    'user-agent',
    'accept',
    'accept-language',
    'accept-encoding',
    'connection',
    'upgrade-insecure-requests',
    'sec-fetch-dest',
    'sec-fetch-mode',
    'sec-fetch-site',
    'sec-fetch-user',
  ],
  headers: {
    accept:
      'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,' +
      'image/png,image/svg+xml,*/*;q=0.8',
    'accept-language': 'en-US,en;q=0.5',
    'accept-encoding': ACCEPT_ENCODING,
    'upgrade-insecure-requests': '1',
    'sec-fetch-dest': 'document',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-site': 'none',
    'sec-fetch-user': '?1',
  },
};

const PROFILES: Record<BrowserPreset, BrowserProfile> = {
  chrome: CHROME,
  firefox: FIREFOX,
};

export function getBrowserProfile(preset: BrowserPreset): BrowserProfile {
  return PROFILES[preset];
}
