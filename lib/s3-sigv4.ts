/**
 * AWS Signature Version 4 for one bodiless S3 request, path-style. The media
 * probe (scripts/media-probe.ts) uses it for a single authorized HEAD that
 * proves a private original exists, so an anonymous 403/404 for it means
 * "refused", not "missing". No SDK: cloud.ru Evolution S3 speaks plain SigV4.
 */
import { createHash, createHmac } from "node:crypto";

export interface S3Credentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly region: string;
}

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const hmac = (key: Buffer | string, s: string) => createHmac("sha256", key).update(s, "utf8").digest();
const EMPTY_SHA256 = sha256("");

/** RFC 3986 encoding of each path segment, as SigV4 canonicalizes it for S3. */
const encodePath = (path: string) =>
  path.split("/").map((seg) => encodeURIComponent(seg).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)).join("/");

/**
 * Headers for `method url` signed with `credentials` at `now`. `extra` headers
 * (lowercase names) are signed too. The URL must carry no query string.
 */
export function signS3Request(method: string, url: URL, credentials: S3Credentials, now: Date,
  extra: Readonly<Record<string, string>> = {}): Record<string, string> {
  if (url.search) throw new Error("signS3Request: query strings are not supported");
  const amzDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const day = amzDate.slice(0, 8);
  const headers: Record<string, string> = {
    host: url.host, "x-amz-content-sha256": EMPTY_SHA256, "x-amz-date": amzDate, ...extra,
  };
  const names = Object.keys(headers).map((n) => n.toLowerCase()).sort();
  const signedHeaders = names.join(";");
  const canonical = [
    method, encodePath(decodeURIComponent(url.pathname)), "",
    ...names.map((n) => `${n}:${headers[n]!.trim()}`), "", signedHeaders, EMPTY_SHA256,
  ].join("\n");
  const scope = `${day}/${credentials.region}/s3/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonical)].join("\n");
  const key = hmac(hmac(hmac(hmac(`AWS4${credentials.secretAccessKey}`, day), credentials.region), "s3"), "aws4_request");
  const signature = createHmac("sha256", key).update(toSign, "utf8").digest("hex");
  // fetch sets Host itself; everything else signed is sent as signed.
  const sent = Object.fromEntries(Object.entries(headers).filter(([name]) => name !== "host"));
  return {
    ...sent,
    authorization: `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}
