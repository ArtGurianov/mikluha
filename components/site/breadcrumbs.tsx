import Link from "next/link";

import type { Crumb } from "@/lib/structured-data";
import { cn } from "@/lib/utils";

/**
 * The visible counterpart of the page's BreadcrumbList JSON-LD — rendered
 * from the same `Crumb[]`, so the markup never describes a trail the visitor
 * can't see. Sits on the dark hero overlay, hence the light text.
 */
export function Breadcrumbs({ crumbs, className }: { crumbs: Crumb[]; className?: string }) {
  return (
    <nav aria-label="Навигационная цепочка" className={cn("text-sm text-white/80", className)}>
      <ol className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
        {crumbs.map((crumb, index) => {
          const isCurrent = index === crumbs.length - 1;
          return (
            <li key={crumb.path} className="flex items-center gap-x-1.5">
              {index > 0 && <span aria-hidden="true">/</span>}
              {isCurrent ? (
                <span aria-current="page">{crumb.name}</span>
              ) : (
                <Link href={crumb.path} className="underline-offset-4 hover:text-white hover:underline">
                  {crumb.name}
                </Link>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
