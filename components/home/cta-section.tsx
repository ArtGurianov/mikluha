import { BookingButton } from "@/components/booking/booking-button";
import type { SiteSettingsDTO } from "@/lib/cms/types";
import { HeroMedia } from "./hero-media";

export function CtaSection({ siteSettings }: { siteSettings: SiteSettingsDTO }) {
  const { hero } = siteSettings;

  return (
    <section className="relative bg-primary text-primary-foreground">
      {/* Same video as the Hero. Lazy so the two copies don't race for the
          same file on load — see HeroMedia's `lazy` prop. */}
      <HeroMedia image={hero.image} video={hero.video} lazy />
      {/* Layered after the poster/video so it always sits on top of both. */}
      <div className="absolute inset-0 bg-linear-to-bl from-secondary/90 to-primary/70" />
      <div className="relative z-10 mx-auto flex max-w-6xl flex-col items-center gap-4 px-4 py-16 text-center sm:px-6">
        <h2 className="font-heading text-2xl font-semibold sm:text-3xl">Готовы в горы?</h2>
        <p className="max-w-xl text-primary-foreground/85">
          Забронируйте место по QR-коду — место закрепляется за вами после подтверждения организатором.
        </p>
        <BookingButton className="mt-4 h-auto px-6 py-3 text-2xl" />
      </div>
    </section>
  );
}
