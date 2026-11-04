const IMAGE_RE = /^\/media\/(?:site|demo)\/[a-z0-9-]+\.webp$/;
const VIDEO_RE = /^\/media\/(?:site|demo)\/[a-z0-9-]+\.webm$/;

export function assertImageSource(sourceRef: string) {
  if (!IMAGE_RE.test(sourceRef)) {
    throw new Error(`Image source must be a tracked /media/site or /media/demo WebP file: "${sourceRef}".`);
  }
}

export function assertVideoSource(sourceRef: string) {
  if (!VIDEO_RE.test(sourceRef)) {
    throw new Error(`Video source must be a tracked /media/site or /media/demo WebM file: "${sourceRef}".`);
  }
}
