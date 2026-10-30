export interface AssetSourcePolicy { remoteBases: URL[]; }

/** Read-only source allowlist, independent of the retired browser CMS writer. */
export const SITE_MEDIA_POLICY: AssetSourcePolicy = {
  remoteBases: [new URL("https://mikluha-maklai.s3.cloud.ru/cms/")],
};

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
        `(the code-owned media source policy).`,
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
