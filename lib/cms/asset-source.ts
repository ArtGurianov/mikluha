export interface AssetSourcePolicy {
  remoteBases: URL[];
}

interface S3MediaLibraryConfig {
  acl?: boolean | string;
  bucket?: string;
  endpoint?: string;
  force_path_style?: boolean;
  prefix?: string;
  public_url?: string;
}

export interface CmsMediaConfig {
  media_libraries?: {
    all?: { max_file_size?: number };
    aws_s3?: S3MediaLibraryConfig;
    default?: false;
    stock_assets?: { providers?: string[] };
  };
}

function directoryUrl(value: string, label: string): URL {
  const url = new URL(value.endsWith("/") ? value : `${value}/`);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error(`${label} must be a plain HTTPS base URL without credentials, query parameters or a fragment.`);
  }
  return url;
}

function appendUrlPath(base: URL, ...segments: string[]): URL {
  const url = new URL(base.href);
  const suffix = segments
    .map((segment) => segment.replace(/^\/+|\/+$/g, ""))
    .filter(Boolean)
    .join("/");
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/${suffix}/`.replace(/\/{2,}/g, "/");
  return url;
}

/**
 * Derives the only remote URL prefixes the configured S3 media library can
 * write. The bucket's configured prefix is part of the boundary: an editor
 * key scoped to `cms/` must never make the build read a sibling object.
 */
export function createAssetSourcePolicy(config: CmsMediaConfig): AssetSourcePolicy {
  const s3 = config.media_libraries?.aws_s3;
  if (!s3) return { remoteBases: [] };

  const prefix = s3.prefix ?? "";
  if (prefix.includes("..") || prefix.includes("\\")) {
    throw new Error("media_libraries.aws_s3.prefix must not contain path traversal segments.");
  }

  const remoteBases: URL[] = [];
  if (s3.public_url) {
    remoteBases.push(appendUrlPath(directoryUrl(s3.public_url, "media_libraries.aws_s3.public_url"), prefix));
  }
  if (s3.endpoint && s3.bucket) {
    const endpointBase = directoryUrl(s3.endpoint, "media_libraries.aws_s3.endpoint");

    // Mirrors the patched Sveltia S3 URL builder (see the pnpm patch note in
    // RUNBOOK.md): force_path_style: false treats `endpoint` itself as the
    // bucket's virtual-hosted-style host, so `bucket` is not appended to the
    // path. Any other value (including unset) keeps the path-style default.
    remoteBases.push(
      s3.force_path_style === false
        ? appendUrlPath(endpointBase, prefix)
        : appendUrlPath(endpointBase, s3.bucket, prefix),
    );
  }
  return { remoteBases };
}

export function parseAllowedRemoteAssetUrl(sourceRef: string, policy: AssetSourcePolicy): URL {
  let url: URL;
  try {
    url = new URL(sourceRef);
  } catch {
    throw new Error(`Asset URL is invalid: "${sourceRef}".`);
  }

  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error(
      `Asset URL must be plain HTTPS without credentials, query parameters or a fragment: "${sourceRef}".`,
    );
  }

  const allowed = policy.remoteBases.some(
    (base) => url.origin === base.origin && url.pathname.startsWith(base.pathname),
  );
  if (!allowed) {
    throw new Error(
      `Refusing media source "${sourceRef}" — it is outside the configured CMS media prefix ` +
        `(public/admin/config.yml media_libraries.aws_s3).`,
    );
  }
  return url;
}

const DEMO_IMAGE_RE = /^\/media\/demo\/[a-z0-9]+(?:-[a-z0-9]+)*\.webp$/;
const DEMO_VIDEO_RE = /^\/media\/demo\/[a-z0-9]+(?:-[a-z0-9]+)*\.webm$/;

function assertMediaSource(sourceRef: string, policy: AssetSourcePolicy, kind: "image" | "video") {
  const demoPattern = kind === "image" ? DEMO_IMAGE_RE : DEMO_VIDEO_RE;
  const extension = kind === "image" ? ".webp" : ".webm";
  if (sourceRef.startsWith("/")) {
    if (!demoPattern.test(sourceRef)) {
      throw new Error(`${kind} source must be a tracked /media/demo/*${extension} file: "${sourceRef}".`);
    }
    return;
  }

  const url = parseAllowedRemoteAssetUrl(sourceRef, policy);
  if (!url.pathname.toLowerCase().endsWith(extension)) {
    throw new Error(`${kind} source must use ${extension}: "${sourceRef}".`);
  }
}

export function assertImageSource(sourceRef: string, policy: AssetSourcePolicy) {
  assertMediaSource(sourceRef, policy, "image");
}

export function assertVideoSource(sourceRef: string, policy: AssetSourcePolicy) {
  assertMediaSource(sourceRef, policy, "video");
}
