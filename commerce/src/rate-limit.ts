import { createHash } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import { isIP } from 'node:net';

interface Bucket { start: number; used: number }

/** Fixed-window counters with reserved shared buckets and a hard bound on keyed buckets. */
export class BookingRateLimiter {
  readonly #windowMs: number;
  readonly #ipLimit: number;
  readonly #emailLimit: number;
  readonly #maxKeyedBuckets: number;
  readonly #keyed = new Map<string, Bucket>();
  #untrusted: Bucket = { start: 0, used: 0 };
  #overflow: Bucket = { start: 0, used: 0 };

  constructor(options: { windowMs?: number; ipLimit?: number; emailLimit?: number; maxKeyedBuckets?: number } = {}) {
    this.#windowMs = options.windowMs ?? 30 * 60_000;
    this.#ipLimit = options.ipLimit ?? 10;
    this.#emailLimit = options.emailLimit ?? 3;
    this.#maxKeyedBuckets = options.maxKeyedBuckets ?? 4096;
  }

  /** Exactly one address is trustworthy behind the one configured reverse-proxy hop. */
  static clientIp(headers: IncomingHttpHeaders): string | null {
    const raw = headers['x-forwarded-for'];
    if (typeof raw !== 'string' || raw.includes(',')) return null;
    const value = raw.trim();
    return isIP(value) === 0 ? null : value;
  }

  #consume(bucket: Bucket, limit: number, now: number): { allowed: boolean; retryAfterSeconds: number } {
    if (now - bucket.start >= this.#windowMs) { bucket.start = now; bucket.used = 0; }
    bucket.used += 1;
    return { allowed: bucket.used <= limit,
      retryAfterSeconds: Math.max(1, Math.ceil((bucket.start + this.#windowMs - now) / 1000)) };
  }

  #keyedBucket(key: string, now: number): Bucket {
    for (const [k, b] of this.#keyed) if (now - b.start >= this.#windowMs) this.#keyed.delete(k);
    const found = this.#keyed.get(key);
    if (found !== undefined) return found;
    if (this.#keyed.size >= this.#maxKeyedBuckets) return this.#overflow;
    const made = { start: now, used: 0 };
    this.#keyed.set(key, made);
    return made;
  }

  checkIp(headers: IncomingHttpHeaders, now = Date.now()) {
    const ip = BookingRateLimiter.clientIp(headers);
    return this.#consume(ip === null ? this.#untrusted : this.#keyedBucket(`ip:${ip}`, now), this.#ipLimit, now);
  }

  checkEmail(email: string, now = Date.now()) {
    const key = createHash('sha256').update(email.trim().toLowerCase(), 'utf8').digest('hex');
    return this.#consume(this.#keyedBucket(`email:${key}`, now), this.#emailLimit, now);
  }

  /** Test/observability only: excludes the two reserved shared buckets. */
  get keyedBucketCount() { return this.#keyed.size; }
}
