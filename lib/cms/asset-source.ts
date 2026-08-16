import { realpath } from "node:fs/promises";
import path from "node:path";

export interface AssetSourcePolicy {
  localAssetsDir: string;
  remoteBases: URL[];
}

interface S3MediaLibraryConfig {
  bucket?: string;
  endpoint?: string;
  prefix?: string;
  public_url?: string;
}

export interface CmsMediaConfig {
  media_libraries?: { aws_s3?: S3MediaLibraryConfig };
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
export function createAssetSourcePolicy(config: CmsMediaConfig, localAssetsDir: string): AssetSourcePolicy {
  const s3 = config.media_libraries?.aws_s3;
  if (!s3) return { localAssetsDir, remoteBases: [] };

  const prefix = s3.prefix ?? "";
  if (prefix.includes("..") || prefix.includes("\\")) {
    throw new Error("media_libraries.aws_s3.prefix must not contain path traversal segments.");
  }

  const remoteBases: URL[] = [];
  if (s3.public_url) {
    remoteBases.push(appendUrlPath(directoryUrl(s3.public_url, "media_libraries.aws_s3.public_url"), prefix));
  }
  if (s3.endpoint && s3.bucket) {
    remoteBases.push(
      appendUrlPath(directoryUrl(s3.endpoint, "media_libraries.aws_s3.endpoint"), s3.bucket, prefix),
    );
  }
  return { localAssetsDir, remoteBases };
}

export function parseAllowedRemoteAssetUrl(sourceRef: string, policy: AssetSourcePolicy): URL {
  let url: URL;
  try {
    url = new URL(sourceRef);
  } catch {
    throw new Error(`Asset URL is invalid: "${sourceRef}".`);
  }

  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new Error(`Asset URL must be plain HTTPS without credentials or a fragment: "${sourceRef}".`);
  }

  const allowed = policy.remoteBases.some(
    (base) => url.origin === base.origin && url.pathname.startsWith(base.pathname),
  );
  if (!allowed) {
    throw new Error(
      `Refusing to download "${sourceRef}" — it is outside the configured CMS media prefix ` +
        `(public/admin/config.yml media_libraries.aws_s3).`,
    );
  }
  return url;
}

/** Resolve a demo `local:` ref without allowing `..`, absolute paths or symlinks to escape content/assets. */
export async function resolveLocalAssetPath(sourceRef: string, policy: AssetSourcePolicy): Promise<string> {
  const filename = sourceRef.slice("local:".length);
  if (!filename || filename !== path.basename(filename) || filename === "." || filename === "..") {
    throw new Error(`Invalid local CMS asset ref "${sourceRef}" — use only a filename from content/assets/.`);
  }

  const [assetsRoot, candidate] = await Promise.all([
    realpath(policy.localAssetsDir),
    realpath(path.join(policy.localAssetsDir, filename)),
  ]);
  const relative = path.relative(assetsRoot, candidate);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Local CMS asset ref "${sourceRef}" resolves outside content/assets/.`);
  }
  return candidate;
}
