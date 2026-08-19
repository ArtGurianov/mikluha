"use client";

import { Menu } from "lucide-react";
import Link from "next/link";

import { BookingButton } from "@/components/booking/booking-button";
import { Button } from "@/components/ui/button";
import { Sheet, SheetClose, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";

import { MaxChannelButton } from "./max-channel-button";
import { navLinks } from "./nav-links";

export function MobileNav({ maxChannelUrl }: { maxChannelUrl?: string }) {
  return (
    <Sheet>
      <SheetTrigger render={<Button variant="ghost" size="icon" className="md:hidden" aria-label="Открыть меню" />}>
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
              render={<Link href={link.href} />}
              className="rounded-md px-2 py-2.5 text-base text-foreground hover:bg-muted"
            >
              {link.label}
            </SheetClose>
          ))}
        </nav>
        <div className="space-y-2 p-4 mt-6">
          <BookingButton className="w-full text-2xl py-6" />
          <MaxChannelButton href={maxChannelUrl} className="w-full text-2xl py-6" />
        </div>
      </SheetContent>
    </Sheet>
  );
}
