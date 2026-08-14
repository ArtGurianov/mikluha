import Image from "next/image";
import Link from "next/link";

import { buttonVariants } from "@/components/ui/button";
import type { SiteSettingsDTO } from "@/lib/cms/types";
import { cn } from "@/lib/utils";

export function Hero({ siteSettings }: { siteSettings: SiteSettingsDTO }) {
  const { hero, siteName } = siteSettings;

  return (
    <section className="relative flex min-h-[85vh] items-end overflow-hidden text-white sm:min-h-[92vh]">
      <Image
        src={hero.image.variants.hero}
        alt={hero.image.alt}
        fill
        priority
        sizes="100vw"
        className="object-cover"
      />
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
