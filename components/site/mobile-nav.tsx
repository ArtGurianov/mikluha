"use client";

import { Menu } from "lucide-react";

import { Button, buttonVariants } from "@/components/ui/button";
import { Sheet, SheetClose, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

import { MaxChannelButton } from "./max-channel-button";
import { navLinks } from "./nav-links";
import { SectionLink } from "./section-link";

export function MobileNav({ maxChannelUrl }: { maxChannelUrl?: string }) {
  return (
    <Sheet>
      <SheetTrigger render={<Button variant="secondary" size="icon" className="md:hidden" aria-label="Открыть меню" />}>
        <Menu />
      </SheetTrigger>
      <SheetContent side="right" className="w-3/4 max-w-xs">
        <SheetHeader>
          <SheetTitle>Меню</SheetTitle>
        </SheetHeader>
        <nav className="flex flex-col gap-1 px-4">
          {navLinks.map((link) => (
            <SheetClose
              key={link.href}
              nativeButton={false}
              render={<SectionLink href={link.href} />}
              className="rounded-md px-2 py-2.5 text-base text-foreground hover:bg-muted"
            >
              {link.label}
            </SheetClose>
          ))}
        </nav>
        <div className="space-y-2 p-4 mt-6">
          <SheetClose
            nativeButton={false}
            render={<SectionLink href="/#tours" />}
            className={cn(buttonVariants(), "w-full py-6 text-2xl font-semibold")}
          >
            Программы и даты
          </SheetClose>
          <MaxChannelButton href={maxChannelUrl} className="w-full text-2xl py-6" />
        </div>
      </SheetContent>
    </Sheet>
  );
}
