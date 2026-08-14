import Image from "next/image";
import Link from "next/link";

import type { ReportDTO } from "@/lib/cms/types";
import { formatSingleDate } from "@/lib/tours";

export function ReportCard({ report, tourTitle }: { report: ReportDTO; tourTitle: string }) {
  return (
    <Link
      href={`/reports/${report.slug}/`}
      data-gallery-item
      className="group/report relative aspect-[4/5] w-[72%] shrink-0 snap-start overflow-hidden rounded-xl bg-muted sm:w-[42%] md:w-[30%] lg:w-[23%]"
    >
      <Image
        src={report.coverImage.variants.card}
        alt={report.coverImage.alt}
        fill
        sizes="(max-width: 640px) 72vw, (max-width: 1024px) 30vw, 23vw"
        className="object-cover transition-transform duration-300 group-hover/report:scale-105"
      />
      <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-black/10 to-transparent" />
      <div className="absolute inset-x-0 bottom-0 space-y-0.5 p-4 text-white">
        {report.date && <p className="text-xs tracking-wide text-white/80 uppercase">{formatSingleDate(report.date)}</p>}
        <p className="font-heading text-sm font-semibold">{tourTitle}</p>
        <p className="text-sm text-white/90">{report.title}</p>
      </div>
    </Link>
  );
}
