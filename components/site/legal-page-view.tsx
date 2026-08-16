import { MarkdownContent } from "@/components/site/markdown-content";
import type { LegalPageDTO } from "@/lib/cms/types";
import { formatSingleDate } from "@/lib/tours";

export function LegalPageView({ page }: { page: LegalPageDTO }) {
  return (
    <article className="mx-auto max-w-3xl px-4 py-14 sm:px-6">
      <h1 className="font-heading text-3xl font-semibold text-foreground sm:text-4xl">{page.title}</h1>
      {page.updatedAt && (
        <p className="mt-2 text-sm text-muted-foreground">Обновлено: {formatSingleDate(page.updatedAt)}</p>
      )}
      <div className="mt-8">
        <MarkdownContent value={page.content} />
      </div>
    </article>
  );
}
