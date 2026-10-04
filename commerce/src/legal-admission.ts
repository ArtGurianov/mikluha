import { request as httpsRequest } from 'node:https';

import type { Catalog } from './catalog.js';

export interface LegalReleaseAdmission { verify(): Promise<void> }

export interface ExpectedRelease {
  readonly sourceCommit: string;
  readonly catalog: Pick<Catalog, 'terms' | 'pdConsent'>;
}

interface SiteRelease {
  schema: number; service: string; sourceCommit: string;
  termsRef: string; termsHash: string; pdConsentRef: string; pdConsentHash: string;
}

const equalRelease = (v: SiteRelease, expected: ExpectedRelease) => v.schema === 1 && v.service === 'mikluha-site'
  && v.sourceCommit === expected.sourceCommit
  && v.termsRef === expected.catalog.terms.ref && v.termsHash === expected.catalog.terms.hash
  && v.pdConsentRef === expected.catalog.pdConsent.ref && v.pdConsentHash === expected.catalog.pdConsent.hash;

export function assertSiteRelease(value: unknown, expected: ExpectedRelease): void {
  if (value === null || typeof value !== 'object' || !equalRelease(value as SiteRelease, expected)) {
    throw new Error('LEGAL_RELEASE_NOT_ADMITTED');
  }
}

function readJson(url: URL, timeoutMs: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(url, { method: 'GET', headers: { accept: 'application/json', 'cache-control': 'no-cache' }, timeout: timeoutMs }, (res) => {
      if (res.statusCode !== 200) { res.resume(); reject(new Error('LEGAL_RELEASE_UNAVAILABLE')); return; }
      const chunks: Buffer[] = [];
      let bytes = 0;
      res.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes <= 8 * 1024) chunks.push(chunk);
        else req.destroy(new Error('LEGAL_RELEASE_TOO_LARGE'));
      });
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch { reject(new Error('LEGAL_RELEASE_UNREADABLE')); }
      });
      res.on('error', () => reject(new Error('LEGAL_RELEASE_UNAVAILABLE')));
    });
    req.on('timeout', () => req.destroy(new Error('LEGAL_RELEASE_TIMEOUT')));
    req.on('error', () => reject(new Error('LEGAL_RELEASE_UNAVAILABLE')));
    req.end();
  });
}

export class LiveSiteReleaseAdmission implements LegalReleaseAdmission {
  readonly #url: URL;
  constructor(siteOrigin: string, readonly expected: ExpectedRelease, readonly timeoutMs = 5_000,
    readonly loader: (url: URL, timeoutMs: number) => Promise<unknown> = readJson) {
    this.#url = new URL('/release.json', siteOrigin);
    if (this.#url.protocol !== 'https:') throw new Error('CONFIG_HTTPS_REQUIRED: SITE_ORIGIN');
  }
  async verify(): Promise<void> {
    try { assertSiteRelease(await this.loader(this.#url, this.timeoutMs), this.expected); }
    catch { throw new Error('LEGAL_RELEASE_NOT_ADMITTED'); }
  }
}
