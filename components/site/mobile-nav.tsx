"use client";

import { Menu } from "lucide-react";
import Link from "next/link";
import * as React from "react";

import { BookingButton } from "@/components/booking/booking-button";
import { Button } from "@/components/ui/button";
import { Sheet, SheetClose, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";

import { navLinks } from "./nav-links";

export function MobileNav() {
  const [open, setOpen] = React.useState(false);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <Button variant="ghost" size="icon" className="md:hidden" aria-label="Открыть меню" onClick={() => setOpen(true)}>
        <Menu />
      </Button>
      <SheetContent side="right" className="w-3/4 max-w-xs">
        <SheetHeader>
          <SheetTitle>Меню</SheetTitle>
        </SheetHeader>
        <nav className="flex flex-col gap-1 px-4">
          {navLinks.map((link) => (
            <SheetClose
              key={link.href}
              render={<Link href={link.href} />}
              className="rounded-md px-2 py-2.5 text-base text-foreground hover:bg-muted"
            >
              {link.label}
            </SheetClose>
          ))}
        </nav>
        <div className="mt-auto p-4">
          <BookingButton className="w-full" />
        </div>
      </SheetContent>
    </Sheet>
  );
}
