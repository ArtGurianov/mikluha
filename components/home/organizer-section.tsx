import Image from "next/image";

import type { OrganizerDTO } from "@/lib/cms/types";
import { telHref } from "@/lib/format";

export function OrganizerSection({ organizers }: { organizers: OrganizerDTO[] }) {
  const listed = organizers.filter((o) => o.isListed);
  if (listed.length === 0) return null;

  return (
    <section id="organizer" className="border-y border-border bg-muted/40">
      <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
        <div className="mb-8 space-y-2">
          <h2 className="font-heading text-2xl font-semibold text-foreground sm:text-3xl">Организатор</h2>
        </div>

        <div className="grid gap-10 sm:grid-cols-2 lg:grid-cols-2">
          {listed.map((organizer) => (
            <div key={organizer.id} className="flex flex-col gap-4 sm:flex-row sm:items-start">
              {organizer.photo && (
                <Image
                  src={organizer.photo.variants.card}
                  alt={organizer.photo.alt}
                  width={128}
                  height={128}
                  className="size-28 shrink-0 rounded-full object-cover ring-1 ring-foreground/10"
                />
              )}
              <div className="space-y-2">
                <h3 className="font-heading text-xl font-semibold text-foreground">{organizer.name}</h3>
                {organizer.bio && <p className="text-muted-foreground">{organizer.bio}</p>}
                <a href={telHref(organizer.phone)} className="inline-block text-sm font-medium underline-offset-4 hover:underline">
                  {organizer.phone}
                </a>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
