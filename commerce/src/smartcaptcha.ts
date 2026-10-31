// TOUR-49: server-side Yandex SmartCaptcha verification for the future native hold boundary.
//
// Policy (docs/plans/2026-10-30-checkout-review-resolution.md, "Conflicts / decisions needed"):
// a proof is accepted only when the provider answers status=ok AND its `host` is an exact member
// of a server-configured Mikluha allowlist. Empty, malformed or foreign (e.g. Flexperiment-only)
// hosts fail closed; no suffix match, no reflection of the request Host header, and provider
// status=ok alone is never enough. Provider failure is CAPTCHA_UNAVAILABLE: no hold is created.
//
// This module is deliberately NOT wired into any route. Hold admission, TTL, idempotency and the
// reservation model belong to TOUR-77/78; this boundary only answers "is this proof acceptable".
// It never logs or returns the token, the server key or the client IP.

import { createHash } from 'node:crypto';
import { isIP } from 'node:net';

export type CaptchaRefusal = 'CAPTCHA_INVALID' | 'CAPTCHA_UNAVAILABLE';
export type CaptchaVerdict = { readonly ok: true } | { readonly ok: false; readonly code: CaptchaRefusal };

/** Fixed, PII-free reasons for observability. Never includes token, key, IP or provider message. */
export type CaptchaReason =
  | 'ACCEPTED' | 'MALFORMED_TOKEN' | 'REPLAYED_TOKEN' | 'PROVIDER_REJECTED' | 'HOST_NOT_ALLOWED'
  | 'PROVIDER_HTTP_ERROR' | 'PROVIDER_TIMEOUT' | 'PROVIDER_NETWORK_ERROR' | 'PROVIDER_MALFORMED_RESPONSE';

export interface SmartCaptchaOptions {
  readonly serverKey: string;
  /** Exact lowercase `hostname` or `hostname:port` values. No wildcards or leading dots. */
  readonly allowedHosts: readonly string[];
  readonly endpoint?: string;
  readonly timeoutMs?: number;
  /** How long a token hash is remembered locally as consumed. Provider one-time use stays authoritative. */
  readonly replayWindowMs?: number;
  readonly maxRememberedTokens?: number;
  /**
   * Off by default: forwarding the buyer's IP to the provider is a PD transfer whose basis and
   * disclosure belong to TOUR-80/84. Enable only after that qualification.
   */
  readonly sendClientIp?: boolean;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly onResult?: (reason: CaptchaReason) => void;
}

/** Yandex Cloud SmartCaptcha validation endpoint. Must be re-qualified against provider docs before activation. */
export const DEFAULT_SMARTCAPTCHA_ENDPOINT = 'https://smartcaptcha.yandexcloud.net/validate';
const TOKEN_RE = /^[\x21-\x7e]{1,4096}$/;
const HOST_RE = /^(?=.{1,253}(?::\d{1,5})?$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*(?::\d{1,5})?$/;

export class SmartCaptchaConfigError extends Error {}

export class SmartCaptchaVerifier {
  readonly #key: string;
  readonly #hosts: ReadonlySet<string>;
  readonly #endpoint: string;
  readonly #timeoutMs: number;
  readonly #replayWindowMs: number;
  readonly #maxRemembered: number;
  readonly #sendClientIp: boolean;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #onResult: (reason: CaptchaReason) => void;
  /** sha256(token) → first-seen time, insertion ordered for bounded eviction. */
  readonly #seen = new Map<string, number>();

  constructor(options: SmartCaptchaOptions) {
    if (typeof options.serverKey !== 'string' || options.serverKey.trim() === '' || /\s/.test(options.serverKey)) {
      throw new SmartCaptchaConfigError('SMARTCAPTCHA_SERVER_KEY_INVALID');
    }
    if (!Array.isArray(options.allowedHosts) || options.allowedHosts.length === 0) {
      throw new SmartCaptchaConfigError('SMARTCAPTCHA_ALLOWED_HOSTS_EMPTY');
    }
    for (const h of options.allowedHosts) {
      if (typeof h !== 'string' || !HOST_RE.test(h) || isIP(h) !== 0) throw new SmartCaptchaConfigError('SMARTCAPTCHA_ALLOWED_HOST_INVALID');
    }
    const endpoint = new URL(options.endpoint ?? DEFAULT_SMARTCAPTCHA_ENDPOINT);
    if (endpoint.protocol !== 'https:' || endpoint.username !== '' || endpoint.password !== '' || endpoint.search !== '' || endpoint.hash !== '') {
      throw new SmartCaptchaConfigError('SMARTCAPTCHA_ENDPOINT_INVALID');
    }
    this.#key = options.serverKey;
    this.#hosts = new Set(options.allowedHosts);
    this.#endpoint = endpoint.href;
    this.#timeoutMs = options.timeoutMs ?? 3_000;
    this.#replayWindowMs = options.replayWindowMs ?? 10 * 60_000;
    this.#maxRemembered = options.maxRememberedTokens ?? 10_000;
    this.#sendClientIp = options.sendClientIp === true;
    this.#fetch = options.fetch ?? fetch;
    this.#now = options.now ?? Date.now;
    this.#onResult = options.onResult ?? (() => {});
  }

  /**
   * Consumes the proof locally BEFORE any await, so concurrent submissions of the same token can
   * reach the provider at most once. A refused or failed check never "un-consumes" it: the client
   * must obtain a fresh proof (the booking form remounts the widget on refusal).
   */
  async verify(token: unknown, clientIp: string | null): Promise<CaptchaVerdict> {
    if (typeof token !== 'string' || !TOKEN_RE.test(token)) return this.#refuse('CAPTCHA_INVALID', 'MALFORMED_TOKEN');
    if (!this.#consume(token)) return this.#refuse('CAPTCHA_INVALID', 'REPLAYED_TOKEN');

    const body = new URLSearchParams({ secret: this.#key, token });
    if (this.#sendClientIp && clientIp !== null && isIP(clientIp) !== 0) body.set('ip', clientIp);
    // One deadline covers the request and the body read. A referenced timer (unlike
    // AbortSignal.timeout) keeps the deadline observable even when nothing else holds the loop.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new DOMException('timeout', 'TimeoutError')), this.#timeoutMs);
    let response: Response;
    let text: string;
    try {
      try {
        response = await this.#fetch(this.#endpoint, {
          method: 'POST', body, redirect: 'error',
          headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
          signal: controller.signal,
        });
      } catch {
        return this.#refuse('CAPTCHA_UNAVAILABLE', controller.signal.aborted ? 'PROVIDER_TIMEOUT' : 'PROVIDER_NETWORK_ERROR');
      }
      if (response.status !== 200) {
        await response.body?.cancel().catch(() => {});
        return this.#refuse('CAPTCHA_UNAVAILABLE', 'PROVIDER_HTTP_ERROR');
      }
      try { text = await response.text(); }
      catch { return this.#refuse('CAPTCHA_UNAVAILABLE', controller.signal.aborted ? 'PROVIDER_TIMEOUT' : 'PROVIDER_NETWORK_ERROR'); }
    } finally { clearTimeout(timer); }
    let parsed: unknown;
    try { parsed = JSON.parse(text); }
    catch { return this.#refuse('CAPTCHA_UNAVAILABLE', 'PROVIDER_MALFORMED_RESPONSE'); }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return this.#refuse('CAPTCHA_UNAVAILABLE', 'PROVIDER_MALFORMED_RESPONSE');
    const { status, host } = parsed as { status?: unknown; host?: unknown };
    if (status === 'failed') return this.#refuse('CAPTCHA_INVALID', 'PROVIDER_REJECTED');
    if (status !== 'ok') return this.#refuse('CAPTCHA_UNAVAILABLE', 'PROVIDER_MALFORMED_RESPONSE');
    // status=ok alone is not enough: the shared key also serves Flexperiment.
    if (typeof host !== 'string' || !this.#hosts.has(host.toLowerCase())) return this.#refuse('CAPTCHA_INVALID', 'HOST_NOT_ALLOWED');
    this.#onResult('ACCEPTED');
    return { ok: true };
  }

  #consume(token: string): boolean {
    const now = this.#now();
    for (const [h, at] of this.#seen) { if (now - at < this.#replayWindowMs) break; this.#seen.delete(h); }
    const digest = createHash('sha256').update(token, 'utf8').digest('hex');
    if (this.#seen.has(digest)) return false;
    // Bounded memory: evict the oldest. An evicted token still meets the provider's one-time check.
    while (this.#seen.size >= this.#maxRemembered) this.#seen.delete(this.#seen.keys().next().value!);
    this.#seen.set(digest, now);
    return true;
  }

  #refuse(code: CaptchaRefusal, reason: CaptchaReason): CaptchaVerdict {
    this.#onResult(reason);
    return { ok: false, code };
  }

  /** Test/observability only. */
  get rememberedTokenCount() { return this.#seen.size; }
}

/** Parses the runtime configuration; absent configuration is an explicit refusal, never "verification off". */
export function smartCaptchaOptionsFromEnv(env: Readonly<Record<string, string | undefined>>): Pick<SmartCaptchaOptions, 'serverKey' | 'allowedHosts'> {
  const serverKey = env.YANDEX_SMARTCAPTCHA_SERVER_KEY ?? '';
  const allowedHosts = (env.SMARTCAPTCHA_ALLOWED_HOSTS ?? '').split(',').map((h) => h.trim()).filter((h) => h !== '');
  if (serverKey === '') throw new SmartCaptchaConfigError('SMARTCAPTCHA_SERVER_KEY_INVALID');
  if (allowedHosts.length === 0) throw new SmartCaptchaConfigError('SMARTCAPTCHA_ALLOWED_HOSTS_EMPTY');
  return { serverKey, allowedHosts };
}
