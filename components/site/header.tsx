import Image from "next/image";
import Link from "next/link";

import { BookingButton } from "@/components/booking/booking-button";
import type { SiteSettingsDTO } from "@/lib/cms/types";

import { MobileNav } from "./mobile-nav";
import { navLinks } from "./nav-links";

export function Header({ siteSettings }: { siteSettings: SiteSettingsDTO }) {
  return (
    <header className="sticky top-0 z-40 border-b border-border/70 bg-background/85 backdrop-blur-sm">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-4 px-4 sm:px-6">
        <Link href="/" className="flex min-w-0 items-center gap-2.5">
          {siteSettings.logo && (
            <Image
              src={siteSettings.logo.variants.thumbnail}
              alt={siteSettings.logo.alt || siteSettings.siteName}
              width={40}
              height={40}
              className="size-10 shrink-0 rounded-full object-cover"
            />
          )}
          <span className="truncate font-heading text-lg font-semibold tracking-tight text-foreground">
            {siteSettings.siteName}
          </span>
        </Link>

        <nav className="hidden items-center gap-6 md:flex">
          {navLinks.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
            >
              {link.label}
            </Link>
          ))}
        </nav>

        <div className="flex items-center gap-2">
          <BookingButton size="sm" label="Забронировать" />
          <MobileNav />
        </div>
      </div>
    </header>
  );
}
