import assert from 'node:assert/strict';
import test from 'node:test';

import { LiveSiteReleaseAdmission, assertSiteRelease } from '../src/legal-admission.js';
import { fixtureCatalog } from './helpers.js';

const sourceCommit = 'a'.repeat(40);
const catalog = fixtureCatalog([]);
const descriptor = {
  schema: 1, service: 'mikluha-site', sourceCommit,
  termsRef: catalog.terms.ref, termsHash: catalog.terms.hash,
  pdConsentRef: catalog.pdConsent.ref, pdConsentHash: catalog.pdConsent.hash,
};

test('live site release must match the commerce commit and both legal artifacts exactly', async () => {
  assert.doesNotThrow(() => assertSiteRelease(descriptor, { sourceCommit, catalog }));
  for (const changed of [
    { ...descriptor, sourceCommit: 'b'.repeat(40) },
    { ...descriptor, termsRef: 'oferta@older' },
    { ...descriptor, termsHash: `sha256:${'0'.repeat(64)}` },
    { ...descriptor, pdConsentRef: 'soglasie-pd@older' },
    { ...descriptor, pdConsentHash: `sha256:${'0'.repeat(64)}` },
  ]) assert.throws(() => assertSiteRelease(changed, { sourceCommit, catalog }), /LEGAL_RELEASE_NOT_ADMITTED/);

  let requested = '';
  const admission = new LiveSiteReleaseAdmission('https://mikluha.example', { sourceCommit, catalog }, 100,
    async (url) => { requested = url.href; return descriptor; });
  await admission.verify();
  assert.equal(requested, 'https://mikluha.example/release.json');
});

test('live admission fails closed on transport, malformed data and non-HTTPS site origin', async () => {
  assert.throws(() => new LiveSiteReleaseAdmission('http://mikluha.example', { sourceCommit, catalog }),
    /CONFIG_HTTPS_REQUIRED/);
  const unavailable = new LiveSiteReleaseAdmission('https://mikluha.example', { sourceCommit, catalog }, 100,
    async () => { throw new Error('network detail'); });
  await assert.rejects(unavailable.verify(), /^Error: LEGAL_RELEASE_NOT_ADMITTED$/);
});
