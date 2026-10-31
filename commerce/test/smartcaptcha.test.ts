// TOUR-49: negative scenarios for the server CAPTCHA boundary. Synthetic provider only; no real
// token, key or provider traffic. Real widget solve, allowed-domain setup and provider responses
// remain NOT_RUN until a separately authorized qualification.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  DEFAULT_SMARTCAPTCHA_ENDPOINT, SmartCaptchaConfigError, SmartCaptchaVerifier, smartCaptchaOptionsFromEnv,
  type CaptchaReason, type SmartCaptchaOptions,
} from '../src/smartcaptcha.js';

const KEY = 'ysc2_synthetic-server-key-for-tests';
const HOSTS = ['mikluha-maklai.ru', 'book.mikluha-maklai.ru'];

interface Call { url: string; body: URLSearchParams; init: RequestInit }

/** A scripted provider: one reply per call, recording exactly what was sent. */
function provider(...replies: Array<(call: Call) => Promise<Response> | Response>) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string | URL, init: RequestInit = {}) => {
    const call = { url: String(url), body: new URLSearchParams(String(init.body)), init };
    calls.push(call);
    const reply = replies[calls.length - 1] ?? replies[replies.length - 1];
    if (reply === undefined) throw new Error('unexpected provider call');
    return reply(call);
  }) as typeof fetch;
  return { calls, fetchImpl };
}
const json = (body: unknown, status = 200) => () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function verifier(fetchImpl: typeof fetch, extra: Partial<SmartCaptchaOptions> = {}) {
  const reasons: CaptchaReason[] = [];
  const v = new SmartCaptchaVerifier({ serverKey: KEY, allowedHosts: HOSTS, fetch: fetchImpl, onResult: (r) => reasons.push(r), ...extra });
  return { v, reasons };
}

describe('acceptance requires provider ok AND an exact allowed host', () => {
  test('ok + exact allowed host is accepted; the key and token go only in the POST body', async () => {
    const p = provider(json({ status: 'ok', message: '', host: 'book.mikluha-maklai.ru' }));
    const { v, reasons } = verifier(p.fetchImpl);
    assert.deepEqual(await v.verify('tok-1', '203.0.113.7'), { ok: true });
    assert.equal(p.calls.length, 1);
    assert.equal(p.calls[0]!.url, DEFAULT_SMARTCAPTCHA_ENDPOINT);
    assert.equal(p.calls[0]!.init.method, 'POST');
    assert.equal(p.calls[0]!.init.redirect, 'error');
    assert.equal(p.calls[0]!.body.get('secret'), KEY);
    assert.equal(p.calls[0]!.body.get('token'), 'tok-1');
    assert.equal(new URL(p.calls[0]!.url).search, '');
    assert.deepEqual(reasons, ['ACCEPTED']);
  });

  test('the client IP is not forwarded unless explicitly enabled after legal qualification', async () => {
    const p = provider(json({ status: 'ok', host: 'mikluha-maklai.ru' }));
    await verifier(p.fetchImpl).v.verify('tok-ip-off', '203.0.113.7');
    assert.equal(p.calls[0]!.body.has('ip'), false);
    const q = provider(json({ status: 'ok', host: 'mikluha-maklai.ru' }));
    const { v } = verifier(q.fetchImpl, { sendClientIp: true });
    await v.verify('tok-ip-on', '203.0.113.7');
    await v.verify('tok-ip-bad', 'not-an-ip');
    assert.equal(q.calls[0]!.body.get('ip'), '203.0.113.7');
    assert.equal(q.calls[1]!.body.has('ip'), false);
  });

  for (const [label, host] of [
    ['empty host', ''], ['missing host', undefined], ['null host', null], ['numeric host', 42],
    ['Flexperiment-only host', 'lab.flexperiment.ru'], ['suffix attack', 'evilmikluha-maklai.ru'],
    ['subdomain not in allowlist', 'www.mikluha-maklai.ru'], ['parent-suffix lookalike', 'mikluha-maklai.ru.evil.example'],
    ['port not admitted', 'mikluha-maklai.ru:8443'], ['trailing dot', 'mikluha-maklai.ru.'],
  ] as const) {
    test(`status=ok with ${label} is refused as CAPTCHA_INVALID`, async () => {
      const p = provider(json({ status: 'ok', ...(host === undefined ? {} : { host }) }));
      const { v, reasons } = verifier(p.fetchImpl);
      assert.deepEqual(await v.verify(`tok-${label.replace(/[^a-z0-9]+/gi, "-")}`, null), { ok: false, code: 'CAPTCHA_INVALID' });
      assert.deepEqual(reasons, ['HOST_NOT_ALLOWED']);
    });
  }

  test('host comparison is DNS case-insensitive but otherwise exact', async () => {
    const p = provider(json({ status: 'ok', host: 'MIKLUHA-maklai.RU' }));
    assert.deepEqual(await verifier(p.fetchImpl).v.verify('tok-case', null), { ok: true });
  });

  test('a deliberately admitted non-default port must be listed exactly', async () => {
    const p = provider(json({ status: 'ok', host: 'staging.mikluha-maklai.ru:8443' }));
    const { v } = verifier(p.fetchImpl, { allowedHosts: ['staging.mikluha-maklai.ru:8443'] });
    assert.deepEqual(await v.verify('tok-port', null), { ok: true });
  });

  test('the request Host header plays no role: only the provider-reported host is compared', async () => {
    // There is no API to pass a request Host; a proof solved on a foreign site stays foreign.
    const p = provider(json({ status: 'ok', host: 'attacker.example' }));
    assert.equal((await verifier(p.fetchImpl).v.verify('tok-reflect', null)).ok, false);
  });
});

describe('invalid, expired and replayed proofs', () => {
  test('provider status=failed (invalid or expired proof) is CAPTCHA_INVALID', async () => {
    const p = provider(json({ status: 'failed', message: 'Token invalid or expired.', host: '' }));
    const { v, reasons } = verifier(p.fetchImpl);
    assert.deepEqual(await v.verify('tok-expired', null), { ok: false, code: 'CAPTCHA_INVALID' });
    assert.deepEqual(reasons, ['PROVIDER_REJECTED']);
  });

  test('malformed tokens are refused without any provider call', async () => {
    const p = provider(json({ status: 'ok', host: 'mikluha-maklai.ru' }));
    const { v, reasons } = verifier(p.fetchImpl);
    for (const bad of [undefined, null, 1, {}, [], '', ' ', 'a b', 'tok\n', 'тест', 'x'.repeat(4097)]) {
      assert.deepEqual(await v.verify(bad, null), { ok: false, code: 'CAPTCHA_INVALID' });
    }
    assert.equal(p.calls.length, 0);
    assert.ok(reasons.every((r) => r === 'MALFORMED_TOKEN'));
  });

  test('an accepted proof cannot be replayed: the second use never reaches the provider', async () => {
    const p = provider(json({ status: 'ok', host: 'mikluha-maklai.ru' }));
    const { v, reasons } = verifier(p.fetchImpl);
    assert.equal((await v.verify('tok-once', null)).ok, true);
    assert.deepEqual(await v.verify('tok-once', null), { ok: false, code: 'CAPTCHA_INVALID' });
    assert.equal(p.calls.length, 1);
    assert.deepEqual(reasons, ['ACCEPTED', 'REPLAYED_TOKEN']);
  });

  test('a refused or failed proof is consumed too; a retry needs a fresh proof', async () => {
    const p = provider(() => { throw new TypeError('fetch failed'); }, json({ status: 'ok', host: 'mikluha-maklai.ru' }));
    const { v } = verifier(p.fetchImpl);
    assert.deepEqual(await v.verify('tok-outage', null), { ok: false, code: 'CAPTCHA_UNAVAILABLE' });
    assert.deepEqual(await v.verify('tok-outage', null), { ok: false, code: 'CAPTCHA_INVALID' });
    assert.equal(p.calls.length, 1);
    assert.equal((await v.verify('tok-fresh', null)).ok, true);
  });

  test('concurrent submissions of one proof reach the provider at most once and win at most once', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const p = provider(async () => { await gate; return json({ status: 'ok', host: 'mikluha-maklai.ru' })(); });
    const { v } = verifier(p.fetchImpl);
    const attempts = Array.from({ length: 25 }, () => v.verify('tok-race', null));
    release();
    const results = await Promise.all(attempts);
    assert.equal(results.filter((r) => r.ok).length, 1);
    assert.equal(results.filter((r) => !r.ok && r.code === 'CAPTCHA_INVALID').length, 24);
    assert.equal(p.calls.length, 1);
  });

  test('local replay memory is bounded and expires; an evicted token still meets the provider check', async () => {
    let now = 0;
    const p = provider(json({ status: 'ok', host: 'mikluha-maklai.ru' }), json({ status: 'ok', host: 'mikluha-maklai.ru' }),
      json({ status: 'ok', host: 'mikluha-maklai.ru' }), json({ status: 'failed', host: '' }));
    const { v } = verifier(p.fetchImpl, { maxRememberedTokens: 2, replayWindowMs: 1_000, now: () => now });
    await v.verify('a', null); await v.verify('b', null); await v.verify('c', null);
    assert.equal(v.rememberedTokenCount, 2);
    // 'a' was evicted locally; the provider's one-time check is the authority and rejects it.
    assert.deepEqual(await v.verify('a', null), { ok: false, code: 'CAPTCHA_INVALID' });
    assert.equal(p.calls.length, 4);
    now = 5_000;
    await v.verify('flood-1', null).catch(() => {});
    assert.equal(v.rememberedTokenCount, 1);
  });
});

describe('provider outage fails closed: CAPTCHA_UNAVAILABLE, never acceptance', () => {
  const cases: Array<[string, () => Response | Promise<Response>, CaptchaReason]> = [
    ['HTTP 500', json({ status: 'ok', host: 'mikluha-maklai.ru' }, 500), 'PROVIDER_HTTP_ERROR'],
    ['HTTP 429', json({}, 429), 'PROVIDER_HTTP_ERROR'],
    ['HTTP 403 (wrong server key)', json({ status: 'failed' }, 403), 'PROVIDER_HTTP_ERROR'],
    ['HTTP 302', () => new Response(null, { status: 302 }), 'PROVIDER_HTTP_ERROR'],
    ['non-JSON body', () => new Response('<html>', { status: 200 }), 'PROVIDER_MALFORMED_RESPONSE'],
    ['JSON array', json([]), 'PROVIDER_MALFORMED_RESPONSE'],
    ['JSON null', json(null), 'PROVIDER_MALFORMED_RESPONSE'],
    ['unknown status', json({ status: 'maybe', host: 'mikluha-maklai.ru' }), 'PROVIDER_MALFORMED_RESPONSE'],
    ['network error', () => { throw new TypeError('fetch failed'); }, 'PROVIDER_NETWORK_ERROR'],
    ['redirect refused by fetch', () => { throw new TypeError('unexpected redirect'); }, 'PROVIDER_NETWORK_ERROR'],
  ];
  for (const [label, reply, reason] of cases) {
    test(label, async () => {
      const { v, reasons } = verifier(provider(reply).fetchImpl);
      assert.deepEqual(await v.verify(`tok-${label.replace(/[^a-z0-9]+/gi, "-")}`, null), { ok: false, code: 'CAPTCHA_UNAVAILABLE' });
      assert.deepEqual(reasons, [reason]);
    });
  }

  test('a hung provider is bounded by the timeout', async () => {
    const hung = (async (_u: string | URL, init: RequestInit = {}) => new Promise<Response>((_, reject) => {
      init.signal?.addEventListener('abort', () => reject(init.signal!.reason));
    })) as typeof fetch;
    const { v, reasons } = verifier(hung, { timeoutMs: 30 });
    const started = Date.now();
    assert.deepEqual(await v.verify('tok-hung', null), { ok: false, code: 'CAPTCHA_UNAVAILABLE' });
    assert.ok(Date.now() - started < 2_000);
    assert.deepEqual(reasons, ['PROVIDER_TIMEOUT']);
  });
});

describe('slow body', () => {
  test('headers that arrive but a body that never finishes are bounded by the same deadline', async () => {
    const slow = (async (_u: string | URL, init: RequestInit = {}) => new Response(new ReadableStream({
      start(c) { init.signal?.addEventListener('abort', () => c.error(init.signal!.reason)); },
    }), { status: 200 })) as typeof fetch;
    const { v, reasons } = verifier(slow, { timeoutMs: 30 });
    assert.deepEqual(await v.verify('tok-slow-body', null), { ok: false, code: 'CAPTCHA_UNAVAILABLE' });
    assert.deepEqual(reasons, ['PROVIDER_TIMEOUT']);
  });
});

describe('no secret, token or IP leaves through results or observability', () => {
  test('every reason and verdict is a fixed code', async () => {
    const seen: string[] = [];
    const p = provider(json({ status: 'failed', message: `secret=${KEY} token=tok-leak`, host: '' }));
    const v = new SmartCaptchaVerifier({ serverKey: KEY, allowedHosts: HOSTS, fetch: p.fetchImpl, sendClientIp: true, onResult: (r) => seen.push(r) });
    const verdict = await v.verify('tok-leak', '203.0.113.9');
    const text = JSON.stringify({ verdict, seen });
    for (const forbidden of [KEY, 'tok-leak', '203.0.113.9', 'secret=']) assert.equal(text.includes(forbidden), false, forbidden);
  });
});

describe('configuration fails closed', () => {
  const base = { serverKey: KEY, allowedHosts: HOSTS };
  for (const [label, override] of [
    ['empty key', { serverKey: '' }], ['blank key', { serverKey: '  ' }], ['key with whitespace', { serverKey: 'a b' }],
    ['no hosts', { allowedHosts: [] }], ['wildcard host', { allowedHosts: ['*.mikluha-maklai.ru'] }],
    ['leading-dot host', { allowedHosts: ['.mikluha-maklai.ru'] }], ['uppercase host', { allowedHosts: ['Mikluha-Maklai.ru'] }],
    ['URL instead of host', { allowedHosts: ['https://mikluha-maklai.ru'] }], ['IP host', { allowedHosts: ['203.0.113.1'] }],
    ['http endpoint', { endpoint: 'http://smartcaptcha.yandexcloud.net/validate' }],
    ['endpoint with credentials', { endpoint: 'https://u:p@smartcaptcha.yandexcloud.net/validate' }],
    ['endpoint with query', { endpoint: 'https://smartcaptcha.yandexcloud.net/validate?secret=x' }],
  ] as const) {
    test(label, () => {
      assert.throws(() => new SmartCaptchaVerifier({ ...base, ...override } as SmartCaptchaOptions), SmartCaptchaConfigError);
    });
  }

  test('absent environment is a refusal, never "verification off"', () => {
    assert.throws(() => smartCaptchaOptionsFromEnv({}), /SMARTCAPTCHA_SERVER_KEY_INVALID/);
    assert.throws(() => smartCaptchaOptionsFromEnv({ YANDEX_SMARTCAPTCHA_SERVER_KEY: KEY, SMARTCAPTCHA_ALLOWED_HOSTS: ' , ' }), /SMARTCAPTCHA_ALLOWED_HOSTS_EMPTY/);
    assert.deepEqual(smartCaptchaOptionsFromEnv({ YANDEX_SMARTCAPTCHA_SERVER_KEY: KEY, SMARTCAPTCHA_ALLOWED_HOSTS: 'mikluha-maklai.ru, book.mikluha-maklai.ru' }),
      { serverKey: KEY, allowedHosts: HOSTS });
  });
});
