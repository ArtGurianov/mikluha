/**
 * Where the SSR site sends browsers for media, decided at request time
 * (ADR v2.3 §2; TOUR-63 owns the image pipeline; TOUR-56 is historical).
 * Switching is a configuration change and a restart of the same image: no
 * rebuild, no content release.
 *
 *   MEDIA_DELIVERY=direct (default)  every URL as stored — the direct HTTPS
 *                                    cloud.ru processed variant.
 *   MEDIA_DELIVERY=cdn               a URL under MEDIA_ORIGIN_BASE is served
 *                                    from MEDIA_CDN_BASE with the same
 *                                    remaining path; anything else as stored.
 *
 * MEDIA_ORIGIN_BASE is the boundary: point it at the public processed-variant
 * prefix (e.g. https://mikluha-maklai.s3.cloud.ru/cms/), and nothing outside
 * it — a private original, another bucket, a same-origin /media/demo/ file —
 * is ever rewritten by this legacy path-preserving mode. Direct cloud.ru
 * remains the production default after the OWNER canceled TurboFlare.
 *
 * VPS-17 Shared Asset Cache has a separate exact-manifest namespace and paths:
 * simply setting MEDIA_CDN_BASE=assets.refref.ru is NOT a qualified mapping.
 * The deferred photo-cache opt-in needs a separate TOUR task, per-media version,
 * publisher, readiness, revoke and fallback acceptance and independent legal GO.
 * None of that is part of TOUR-63 stage 1 or SSR cutover Done criteria.
 * This comment update makes no runtime behavior change.
 */

export type MediaDelivery =
  | { readonly mode: "direct" }
  | { readonly mode: "cdn"; readonly origin: URL; readonly cdn: URL };

function base(value: string | undefined, name: string): URL {
  if (!value) throw new Error(`MEDIA_DELIVERY=cdn requires ${name}`);
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash
    || !url.pathname.endsWith("/")) {
    throw new Error(`${name} must be a plain HTTPS base URL ending in "/", without credentials, query or fragment`);
  }
  return url;
}

export function mediaDeliveryFromEnv(env: Record<string, string | undefined> = process.env): MediaDelivery {
  const mode = env.MEDIA_DELIVERY?.trim() || "direct";
  if (mode === "direct") return { mode };
  if (mode !== "cdn") throw new Error(`MEDIA_DELIVERY must be "direct" or "cdn", got "${mode}"`);
  return { mode, origin: base(env.MEDIA_ORIGIN_BASE, "MEDIA_ORIGIN_BASE"), cdn: base(env.MEDIA_CDN_BASE, "MEDIA_CDN_BASE") };
}

export function resolveMediaUrl(src: string, delivery: MediaDelivery): string {
  if (delivery.mode === "direct") return src;
  let url: URL;
  try {
    url = new URL(src);
  } catch {
    return src; // same-origin /media/demo/ files
  }
  if (url.origin !== delivery.origin.origin || !url.pathname.startsWith(delivery.origin.pathname)
    || url.username || url.password) {
    return src;
  }
  const rest = url.pathname.slice(delivery.origin.pathname.length);
  return new URL(`${delivery.cdn.pathname}${rest}${url.search}`, delivery.cdn.origin).href;
}

/** Every `src` of every image and video asset in a snapshot, resolved; nothing else is touched. */
export function withMediaDelivery<T>(value: T, delivery: MediaDelivery): T {
  if (delivery.mode === "direct") return value;
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v === null || typeof v !== "object") return v;
    return Object.fromEntries(Object.entries(v).map(([key, item]) =>
      [key, key === "src" && typeof item === "string" ? resolveMediaUrl(item, delivery) : walk(item)]));
  };
  return walk(value) as T;
}
