#!/usr/bin/env tsx
/**
 * TurboFlare × cloud.ru Evolution S3 probe (TOUR-56). Requests one public
 * processed variant directly and through the CDN custom host, proves with one
 * authorized HEAD that a private original exists, requests it anonymously both
 * ways, then prints the pass/fail matrix (lib/media-probe.ts). Non-production
 * objects only; it reads, never writes. Run protocol:
 * docs/plans/2026-10-29-tour-56-turboflare-poc.md.
 *
 *   PROBE_ORIGIN_BASE=https://mikluha-maklai.s3.cloud.ru/cms/   direct public variant base
 *   PROBE_CDN_BASE=https://<turboflare custom host>/cms/         the same objects via TurboFlare
 *   PROBE_VARIANT=probe/turboflare-probe.webp                     relative to both bases
 *   PROBE_PRIVATE_URL=https://…/originals/probe.jpg               a private original, anonymous direct URL
 *   PROBE_PRIVATE_CDN_URL=https://<host>/originals/probe.jpg      the CDN path that would map to it
 *   PROBE_S3_ENDPOINT=https://s3.cloud.ru, PROBE_S3_REGION=ru-central-1,
 *   PROBE_S3_BUCKET, PROBE_PRIVATE_KEY (object key), PROBE_S3_ACCESS_KEY_ID,
 *   PROBE_S3_SECRET_ACCESS_KEY                                    a read-only key for the authorized HEAD
 *   PROBE_SITE_ORIGIN=https://mikluha-maklai.ru                   Origin sent for CORS
 *   PROBE_MIN_TTL=86400                                           minimum edge TTL, seconds
 *   PROBE_OUT=<dir>                                               optional: write probe-<time>.{json,md}
 *
 * Exit status: 0 TECHNICAL_PASS, 1 TECHNICAL_FAIL, 2 bad input.
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { evaluate, matrixMarkdown, technicalResult, type Observed, type ProbeRun } from "../lib/media-probe";
import { signS3Request } from "../lib/s3-sigv4";

const MAX_BYTES = 16 * 1024 * 1024;

function env(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(`[media-probe] ${name} is required`);
    process.exit(2);
  }
  return value;
}

function httpsBase(name: string, trailingSlash = true): URL {
  const url = new URL(env(name));
  if (url.protocol !== "https:" || (trailingSlash && !url.pathname.endsWith("/")) || url.search || url.username) {
    console.error(`[media-probe] ${name} must be an https ${trailingSlash ? 'base ending in "/"' : "origin"}`);
    process.exit(2);
  }
  return url;
}

async function observe(url: string,
  init: { origin?: string; body?: boolean; method?: string; headers?: Record<string, string> } = {}): Promise<Observed> {
  try {
    const res = await fetch(url, {
      method: init.method ?? "GET",
      redirect: "manual",
      cache: "no-store",
      headers: { ...(init.origin ? { origin: init.origin } : {}), ...init.headers },
      signal: AbortSignal.timeout(15_000),
    });
    const headers = Object.fromEntries([...res.headers].map(([k, v]) => [k.toLowerCase(), v]));
    if (!init.body || res.status !== 200) {
      await res.body?.cancel();
      return { url, status: res.status, headers };
    }
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length > MAX_BYTES) return { url, status: res.status, headers, error: "BODY_TOO_LARGE" };
    return { url, status: res.status, headers, sha256: createHash("sha256").update(bytes).digest("hex") };
  } catch (error) {
    const cause = (error as { cause?: { code?: string } }).cause?.code;
    return { url, status: null, headers: {}, error: cause ?? (error as Error).name };
  }
}

async function main() {
  const originBase = httpsBase("PROBE_ORIGIN_BASE");
  const cdnBase = httpsBase("PROBE_CDN_BASE");
  const variant = env("PROBE_VARIANT").replace(/^\/+/, "");
  const siteOrigin = process.env.PROBE_SITE_ORIGIN?.trim() || "https://mikluha-maklai.ru";
  const minTtlSeconds = Number(process.env.PROBE_MIN_TTL ?? 86_400);
  const originUrl = new URL(variant, originBase).href;
  const cdnUrl = new URL(variant, cdnBase).href;
  // A query the edge has never seen: the first request has to go to the origin.
  const fresh = `${cdnUrl}?probe=${randomBytes(8).toString("hex")}`;

  const s3 = httpsBase("PROBE_S3_ENDPOINT", false);
  const existsUrl = new URL(`/${env("PROBE_S3_BUCKET")}/${env("PROBE_PRIVATE_KEY").replace(/^\/+/, "")}`, s3);
  const signed = signS3Request("HEAD", existsUrl, {
    accessKeyId: env("PROBE_S3_ACCESS_KEY_ID"), secretAccessKey: env("PROBE_S3_SECRET_ACCESS_KEY"),
    region: process.env.PROBE_S3_REGION?.trim() || "ru-central-1",
  }, new Date());

  const run: ProbeRun = {
    originVariant: await observe(originUrl, { body: true }),
    cdnVariant: await observe(cdnUrl, { body: true, origin: siteOrigin }),
    cdnFirst: await observe(fresh),
    cdnSecond: await observe(fresh),
    cdnPlainHttp: await observe(cdnUrl.replace(/^https:/, "http:")),
    privateExists: await observe(existsUrl.href, { method: "HEAD", headers: signed }),
    originPrivate: await observe(env("PROBE_PRIVATE_URL")),
    cdnPrivate: await observe(env("PROBE_PRIVATE_CDN_URL")),
    siteOrigin,
    minTtlSeconds,
  };
  const rows = evaluate(run);
  const result = technicalResult(rows);
  const at = new Date().toISOString();
  const markdown = `# Media probe ${at}\n\n${matrixMarkdown(rows)}\n\n**${result}** — a technical result only; ` +
    "TurboFlare stays inactive until the legal go/no-go passes as well.\n";
  console.log(markdown);

  if (process.env.PROBE_OUT) {
    const dir = path.resolve(process.env.PROBE_OUT);
    await mkdir(dir, { recursive: true });
    const name = `probe-${at.replaceAll(":", "-")}`;
    await writeFile(path.join(dir, `${name}.json`), `${JSON.stringify({ at, result, rows, run }, null, 2)}\n`);
    await writeFile(path.join(dir, `${name}.md`), markdown);
    console.log(`[media-probe] wrote ${path.join(dir, name)}.{json,md}`);
  }
  process.exit(result === "TECHNICAL_PASS" ? 0 : 1);
}

main().catch((error) => {
  console.error("[media-probe] failed:", error);
  process.exit(2);
});
