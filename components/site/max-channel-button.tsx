import type { VariantProps } from "class-variance-authority";
import type { SVGProps } from "react";

import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface MaxChannelButtonProps extends VariantProps<typeof buttonVariants> {
  href?: string;
  label?: string;
  className?: string;
}

/** MAX's own icon, matching the text color (`currentColor`) — originally `components/max.svg`. */
function MaxIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 1024 1024" fill="currentColor" aria-hidden="true" {...props}>
      <g transform="translate(0,1024) scale(0.1,-0.1)">
        <path d="M4906 10100 c-1330 -98 -2450 -598 -3306 -1476 -792 -812 -1265 -1860 -1395 -3089 -22 -206 -31 -743 -16 -965 25 -361 78 -708 177 -1150 20 -85 104 -429 189 -765 252 -1000 315 -1346 330 -1810 4 -104 13 -223 20 -264 52 -267 238 -391 589 -391 271 0 574 84 903 251 232 118 409 242 550 386 l91 94 144 -94 c567 -369 840 -487 1328 -571 251 -44 434 -59 715 -59 267 -1 419 9 655 44 811 118 1586 443 2275 954 363 268 732 635 1008 1002 578 767 929 1763 966 2738 39 1066 -243 2076 -834 2975 -479 731 -1130 1314 -1895 1696 -523 261 -1052 415 -1650 479 -171 19 -671 27 -844 15z m599 -2454 c295 -44 547 -124 805 -252 741 -371 1249 -1081 1377 -1924 23 -157 23 -482 0 -641 -81 -546 -330 -1034 -732 -1434 -410 -407 -904 -652 -1485 -736 -129 -19 -462 -16 -600 4 -332 50 -668 173 -943 347 l-98 62 -68 -59 c-37 -32 -115 -99 -173 -149 -254 -220 -412 -283 -523 -210 -90 59 -210 337 -295 680 -130 527 -170 1222 -105 1831 59 558 212 1000 490 1420 116 175 218 297 373 446 196 189 371 312 607 425 222 106 430 167 678 199 144 18 548 13 692 -9z" />
      </g>
    </svg>
  );
}

/** MAX's brand gradient — teal-to-blue-to-purple — is the only thing that distinguishes this CTA from the primary Button. */
export function MaxChannelButton({ href, label = "Канал в MAX", size, className }: MaxChannelButtonProps) {
  if (!href) return null;

  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className={cn(
        buttonVariants({ size }),
        "bg-linear-to-r from-teal-500 via-blue-500 to-purple-500 font-semibold text-white hover:opacity-90",
        className,
      )}
    >
      {label}
      <MaxIcon className="size-4" />
    </a>
  );
}
