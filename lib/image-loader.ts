/**
 * Custom next/image loader for static export.
 *
 * Every CMS image URL in this app already points at one of five pre-generated
 * local variants — /generated/cms/<hash>/<thumbnail|card|gallery|hero|lightbox>.webp
 * (see scripts/materialize-assets.ts). This loader lets next/image build a
 * real `srcset`/`sizes` by remapping the requested width to the nearest
 * variant that actually exists on disk, instead of `images.unoptimized: true`
 * (which serves the exact same file at every width). It never talks to a
 * remote optimizer and only ever returns local /generated/cms paths — safe
 * for `output: 'export'`.
 */

const VARIANT_WIDTHS: Record<string, number> = {
  thumbnail: 400,
  card: 800,
  gallery: 1400,
  hero: 2200,
  lightbox: 2600,
};

const CMS_IMAGE_RE = /^(\/generated\/cms\/[^/]+\/)(thumbnail|card|gallery|hero|lightbox)\.webp$/;

export default function cmsImageLoader({ src, width }: { src: string; width: number; quality?: number }): string {
  const match = CMS_IMAGE_RE.exec(src);
  if (!match) return src;

  const [, dir] = match;

  let bestName = "lightbox";
  let bestWidth = Infinity;
  for (const [name, variantWidth] of Object.entries(VARIANT_WIDTHS)) {
    if (variantWidth >= width && variantWidth < bestWidth) {
      bestWidth = variantWidth;
      bestName = name;
    }
  }

  return `${dir}${bestName}.webp`;
}
