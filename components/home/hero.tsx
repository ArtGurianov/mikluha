import Link from "next/link";

import { MaxChannelButton } from "@/components/site/max-channel-button";
import { buttonVariants } from "@/components/ui/button";
import type { SiteSettingsDTO } from "@/lib/cms/types";
import { cn } from "@/lib/utils";

import { HeroMedia } from "./hero-media";

export function Hero({ siteSettings }: { siteSettings: SiteSettingsDTO }) {
  const { hero, siteName, socials } = siteSettings;

  return (
    <section className="relative flex min-h-[85vh] items-end overflow-hidden text-white sm:min-h-[92vh]">
      <HeroMedia image={hero.image} video={hero.video} />
      {/* Layered after the poster/video so it always sits on top of both. */}
      <div className="absolute inset-0 bg-linear-to-br from-secondary/60 to-primary/60" />

      <div className="relative z-10 mx-auto w-full max-w-6xl space-y-5 px-4 pb-16 sm:px-6 sm:pb-24">
        <p className="text-sm font-semibold tracking-[0.2em] text-white/80 uppercase">{siteName}</p>
        <h1 className="font-heading max-w-2xl text-4xl font-semibold text-balance sm:text-5xl lg:text-6xl">
          {hero.title}
        </h1>
        {hero.subtitle && <p className="max-w-xl text-lg text-white/85">{hero.subtitle}</p>}

        <div className="flex flex-col sm:flex-row gap-3 pt-2">
          <Link
            href="#tours"
            className={cn(buttonVariants(), "h-auto px-6 py-2 text-2xl font-semibold")}
          >
            Ближайшие туры
          </Link>
          <MaxChannelButton href={socials.maxChannelUrl} className="h-auto px-6 py-2 text-2xl" />
        </div>
      </div>
    </section>
  );
}
