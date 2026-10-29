/**
 * The technical half of the TurboFlare × cloud.ru Evolution S3 qualification
 * (TOUR-56): what one probe run observed, judged into a pass/fail matrix.
 * scripts/media-probe.ts makes the requests; this module only decides, so the
 * rules are tested without a network. A technical PASS is not a qualification:
 * TurboFlare is activated only after the legal go/no-go passes too, and until
 * then direct cloud.ru processed-variant URLs are the normal production mode.
 */

export interface Observed {
  readonly url: string;
  /** null: the request failed (TLS, DNS, refused, timeout); `error` says how. */
  readonly status: number | null;
  readonly error?: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly sha256?: string;
}

export interface ProbeRun {
  readonly originVariant: Observed;
  readonly cdnVariant: Observed;
  /** Two requests for one never-requested-before CDN URL, in order. */
  readonly cdnFirst: Observed;
  readonly cdnSecond: Observed;
  /** The same variant through the CDN host over plain HTTP. */
  readonly cdnPlainHttp: Observed;
  /** An authorized (SigV4) HEAD of the private original: it must exist for a refusal to mean anything. */
  readonly privateExists: Observed;
  /** The same original, anonymously: directly, and through the CDN host. */
  readonly originPrivate: Observed;
  readonly cdnPrivate: Observed;
  readonly siteOrigin: string;
  readonly minTtlSeconds: number;
}

export interface ProbeInput {
  /** Direct cloud.ru base of the public variants, virtual-hosted: `https://<bucket>.s3.cloud.ru/cms/`. */
  readonly originBase: string;
  /** The TurboFlare custom host fronting the same bucket, same path: `https://<host>/cms/`. */
  readonly cdnBase: string;
  /** A public processed variant, relative to both bases. */
  readonly variant: string;
  /** A private original's object key in that bucket, e.g. `originals/probe.jpg`. */
  readonly privateKey: string;
}

export interface ProbeTargets {
  readonly originVariant: string;
  readonly cdnVariant: string;
  /** Signed HEAD and anonymous direct request: one URL. */
  readonly originPrivate: string;
  /** The same object key on the CDN host. */
  readonly cdnPrivate: string;
}

/**
 * Every URL the probe requests, from one bucket host, one CDN host and one key, so the anonymous
 * refusals (T9, T10) are about the very object the authorized HEAD (T8) found. The CDN mapping
 * supported is a host swap: both bases must have the same path, which T4 then proves byte for byte.
 */
export function probeTargets(input: ProbeInput): ProbeTargets {
  const base = (name: string, value: string) => {
    const url = new URL(value);
    if (url.protocol !== "https:" || !url.pathname.endsWith("/") || url.search || url.hash || url.username) {
      throw new Error(`${name} must be an https base ending in "/"`);
    }
    return url;
  };
  const origin = base("PROBE_ORIGIN_BASE", input.originBase);
  const cdn = base("PROBE_CDN_BASE", input.cdnBase);
  if (origin.pathname !== cdn.pathname) {
    throw new Error(`PROBE_CDN_BASE must map PROBE_ORIGIN_BASE by host only (${origin.pathname} vs ${cdn.pathname})`);
  }
  const relative = (name: string, value: string) => {
    const v = value.replace(/^\/+/, "");
    if (!v || /[?#\\]/.test(v) || v.split("/").some((seg) => ["", ".", ".."].includes(decodeURIComponent(seg)))) {
      throw new Error(`${name} must be a plain relative path, got "${value}"`);
    }
    return v;
  };
  const variant = relative("PROBE_VARIANT", input.variant);
  const key = relative("PROBE_PRIVATE_KEY", input.privateKey);
  return {
    originVariant: new URL(variant, origin).href,
    cdnVariant: new URL(variant, cdn).href,
    originPrivate: new URL(`/${key}`, origin).href,
    cdnPrivate: new URL(`/${key}`, cdn).href,
  };
}

/** The three private requests name one object: signed and anonymous direct are the same URL, the CDN one its path on the variant's CDN host. */
export function samePrivateObject(run: ProbeRun): boolean {
  const [exists, direct, viaCdn] = [run.privateExists.url, run.originPrivate.url, run.cdnPrivate.url].map((u) => new URL(u));
  return exists!.href === direct!.href
    && direct!.host === new URL(run.originVariant.url).host
    && viaCdn!.host === new URL(run.cdnVariant.url).host
    && viaCdn!.pathname === direct!.pathname && viaCdn!.search === "" && direct!.search === "";
}

export type Verdict = "PASS" | "FAIL";

export interface MatrixRow {
  readonly id: string;
  readonly check: string;
  /** A failed required row fails the technical result; the others are recorded for the decision. */
  readonly required: boolean;
  readonly verdict: Verdict;
  readonly evidence: string;
}

const MIME: Readonly<Record<string, string>> = {
  webp: "image/webp", avif: "image/avif", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png",
  webm: "video/webm", mp4: "video/mp4",
};

export function expectedMime(url: string): string | undefined {
  const ext = /\.([a-z0-9]+)$/i.exec(new URL(url).pathname)?.[1]?.toLowerCase();
  return ext === undefined ? undefined : MIME[ext];
}

/** HIT/MISS from whichever cache header the edge sends; UNKNOWN when it sends none of them. */
export function cacheStatus(headers: Readonly<Record<string, string>>): "HIT" | "MISS" | "UNKNOWN" {
  for (const name of ["cf-cache-status", "x-cache-status", "x-cache", "x-proxy-cache", "cdn-cache", "x-edge-cache"]) {
    const value = headers[name]?.toUpperCase();
    if (value === undefined) continue;
    if (value.includes("HIT")) return "HIT";
    if (value.includes("MISS") || value.includes("EXPIRED") || value.includes("BYPASS")) return "MISS";
  }
  const age = Number(headers.age);
  if (Number.isFinite(age) && age > 0) return "HIT";
  return "UNKNOWN";
}

export function maxAge(headers: Readonly<Record<string, string>>): number | null {
  const cc = headers["cache-control"] ?? "";
  const m = /(?:^|,)\s*s-maxage=(\d+)/i.exec(cc) ?? /(?:^|,)\s*max-age=(\d+)/i.exec(cc);
  return m ? Number(m[1]) : null;
}

const said = (o: Observed) => (o.status === null ? `no response (${o.error ?? "error"})` : `${o.status}`);
const row = (id: string, check: string, required: boolean, ok: boolean, evidence: string): MatrixRow =>
  ({ id, check, required, verdict: ok ? "PASS" : "FAIL", evidence });

export function evaluate(run: ProbeRun): MatrixRow[] {
  const { originVariant: o, cdnVariant: c } = run;
  const mime = expectedMime(o.url);
  const ctype = (x: Observed) => (x.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
  const first = cacheStatus(run.cdnFirst.headers);
  const second = cacheStatus(run.cdnSecond.headers);
  const ttl = maxAge(c.headers);
  const acao = c.headers["access-control-allow-origin"];
  const plain = run.cdnPlainHttp;
  const plainLocation = plain.headers.location ?? "";
  // A refusal counts only as an HTTP answer about an object known to exist. A DNS, TLS or timeout
  // failure proves nothing about access, and S3 answers 403 for missing objects too.
  // And only about that object: a refusal of some other key proves nothing about this one.
  const same = samePrivateObject(run);
  const exists = same && run.privateExists.status === 200;
  const refused = (x: Observed) => exists && (x.status === 401 || x.status === 403 || x.status === 404);
  const refusal = (x: Observed) => `${x.url} → ${said(x)}${!same ? "; not the object of T8" : exists ? "" : "; existence not confirmed"}`;

  return [
    row("T1", "Direct cloud.ru HTTPS serves the processed variant", true, o.status === 200, `${o.url} → ${said(o)}`),
    row("T2", "CDN custom host serves it over valid TLS, without a redirect", true, c.status === 200, `${c.url} → ${said(c)}`),
    row("T3", "MIME type matches the variant on both", true,
      mime !== undefined && ctype(o) === mime && ctype(c) === mime, `expected ${mime ?? "?"}; origin ${ctype(o) || "—"}, CDN ${ctype(c) || "—"}`),
    row("T4", "CDN bytes are the origin's bytes", true,
      o.sha256 !== undefined && o.sha256 === c.sha256, `origin ${o.sha256 ?? "—"}, CDN ${c.sha256 ?? "—"}`),
    row("T5", "Cache MISS on first request, HIT on the second", true,
      run.cdnFirst.status === 200 && run.cdnSecond.status === 200 && first === "MISS" && second === "HIT",
      `${said(run.cdnFirst)} ${first}, then ${said(run.cdnSecond)} ${second}`),
    row("T6", `Edge TTL at least ${run.minTtlSeconds} s`, true, ttl !== null && ttl >= run.minTtlSeconds,
      `cache-control: ${c.headers["cache-control"] ?? "—"}`),
    row("T7", "CDN sets no cookie", true, c.status === 200 && c.headers["set-cookie"] === undefined,
      c.status === 200 ? c.headers["set-cookie"] ?? "none" : `no variant response (${said(c)})`),
    row("T8", "Private original exists (authorized HEAD)", true, exists,
      `${run.privateExists.url} → ${said(run.privateExists)}${same ? "" : "; T8–T10 do not name one object"}`),
    row("T9", "Private original is refused directly (401/403/404)", true, refused(run.originPrivate),
      refusal(run.originPrivate)),
    row("T10", "Private original is refused through the CDN host (401/403/404)", true, refused(run.cdnPrivate),
      refusal(run.cdnPrivate)),
    row("T11", "Plain HTTP on the CDN host redirects to HTTPS or is refused", false,
      plain.status === null || ([301, 302, 307, 308].includes(plain.status) && plainLocation.startsWith("https://")),
      `${plain.url} → ${said(plain)} ${plainLocation}`.trim()),
    row("T12", "CORS allows the site origin", true, acao === "*" || acao === run.siteOrigin,
      `access-control-allow-origin: ${acao ?? "—"} (requested from ${run.siteOrigin})`),
    row("T13", "CDN sends X-Content-Type-Options: nosniff", false,
      (c.headers["x-content-type-options"] ?? "").toLowerCase() === "nosniff", c.headers["x-content-type-options"] ?? "—"),
    row("T14", "CDN sends Strict-Transport-Security", false, c.headers["strict-transport-security"] !== undefined,
      c.headers["strict-transport-security"] ?? "—"),
  ];
}

export function technicalResult(rows: readonly MatrixRow[]): "TECHNICAL_PASS" | "TECHNICAL_FAIL" {
  return rows.every((r) => !r.required || r.verdict === "PASS") ? "TECHNICAL_PASS" : "TECHNICAL_FAIL";
}

export function matrixMarkdown(rows: readonly MatrixRow[]): string {
  const cell = (s: string) => s.replaceAll("|", "\\|").replaceAll("\n", " ");
  return [
    "| ID | Check | Required | Verdict | Evidence |",
    "|---|---|---|---|---|",
    ...rows.map((r) => `| ${r.id} | ${cell(r.check)} | ${r.required ? "yes" : "no"} | ${r.verdict} | ${cell(r.evidence)} |`),
  ].join("\n");
}
