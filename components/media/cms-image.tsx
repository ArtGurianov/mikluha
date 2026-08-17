import type { ComponentProps } from "react";

import type { ImageAsset } from "@/lib/cms/types";

type CmsImageProps = Omit<ComponentProps<"img">, "alt" | "src"> & {
  image: ImageAsset;
};

/** Native image rendering for already-optimized WebP media. */
export function CmsImage({ image, decoding = "async", loading = "lazy", ...props }: CmsImageProps) {
  // The CMS accepts WebP only; there is intentionally no Next/runtime optimizer.
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={image.src} alt={image.alt} decoding={decoding} loading={loading} {...props} />;
}
