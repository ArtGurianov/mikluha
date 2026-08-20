"use client";

import type { ComponentPropsWithRef, MouseEvent } from "react";
import Link from "next/link";

import { scrollToRepeatedSection } from "@/lib/section-navigation";

type SectionLinkProps = Omit<ComponentPropsWithRef<typeof Link>, "href"> & { href: string };

export function SectionLink({ href, onClick, target, ...props }: SectionLinkProps) {
  function handleClick(event: MouseEvent<HTMLAnchorElement>) {
    onClick?.(event);
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey ||
      (target && target !== "_self")
    ) {
      return;
    }

    const handled = scrollToRepeatedSection(window.location.href, href, (id) => document.getElementById(id));
    if (handled) event.preventDefault();
  }

  return <Link {...props} href={href} target={target} onClick={handleClick} />;
}
