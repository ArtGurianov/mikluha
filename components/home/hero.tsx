import Link from "next/link";

import { CmsImage } from "@/components/media/cms-image";
import { buttonVariants } from "@/components/ui/button";
import type { SiteSettingsDTO } from "@/lib/cms/types";
import { cn } from "@/lib/utils";

export function Hero({ siteSettings }: { siteSettings: SiteSettingsDTO }) {
  const { hero, siteName } = siteSettings;

  return (
    <section className="relative flex min-h-[85vh] items-end overflow-hidden text-white sm:min-h-[92vh]">
      <CmsImage
        image={hero.image}
        loading="eager"
        fetchPriority="high"
        className="absolute inset-0 size-full object-cover"
      />
      {hero.video && (
        <video
          className="absolute inset-0 size-full object-cover motion-reduce:hidden"
          autoPlay
          muted
          loop
          playsInline
          preload="metadata"
          poster={hero.image.src}
          aria-hidden="true"
          tabIndex={-1}
        >
          <source src={hero.video.src} type="video/webm" media="(prefers-reduced-motion: no-preference)" />
        </video>
      )}
      <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/30 to-black/10" />

      <div className="relative z-10 mx-auto w-full max-w-6xl space-y-5 px-4 pb-16 sm:px-6 sm:pb-24">
        <p className="text-sm font-semibold tracking-[0.2em] text-white/80 uppercase">{siteName}</p>
        <h1 className="font-heading max-w-2xl text-4xl font-semibold text-balance sm:text-5xl lg:text-6xl">
          {hero.title}
        </h1>
        {hero.subtitle && <p className="max-w-xl text-lg text-white/85">{hero.subtitle}</p>}

        <div className="flex flex-wrap gap-3 pt-2">
          <Link href="#tours" className={cn(buttonVariants({ size: "lg" }), "text-base")}>
            Смотреть ближайшие туры
          </Link>
        </div>
      </div>
    </section>
  );
}
