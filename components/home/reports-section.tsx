import type { ContentSnapshot } from "@/lib/cms/types";
import { getAllReportsSorted, getTourById } from "@/lib/tours";

import { ReportCard } from "./report-card";

export function ReportsSection({ content }: { content: ContentSnapshot }) {
  const reports = getAllReportsSorted(content);
  if (reports.length === 0) return null;

  return (
    <section id="reports" className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
      <div className="mb-8 space-y-2">
        <h2 className="font-heading text-2xl font-semibold text-foreground sm:text-3xl">Отчёты о поездках</h2>
        <p className="max-w-2xl text-muted-foreground">Атмосфера прошлых выездов — в фотографиях от участников.</p>
      </div>

      <div className="scrollbar-none flex snap-x snap-mandatory gap-4 overflow-x-auto pb-2">
        {reports.map((report) => (
          <ReportCard key={report.id} report={report} tourTitle={getTourById(content, report.tourId)?.title ?? ""} />
        ))}
      </div>
    </section>
  );
}
