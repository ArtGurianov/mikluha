import { MarkdownContent } from "@/components/site/markdown-content";
import type { LegalPageDTO } from "@/lib/cms/types";
import { formatSingleDate } from "@/lib/tours";
import { leadingLegalTitleOffset } from "@/lib/legal-markdown";

export function LegalPageView({ page }: { page: LegalPageDTO }) {
  const titleOffset = leadingLegalTitleOffset(page.content);
  const metadata = <>
    {page.updatedAt && <p className="mt-2 text-sm text-muted-foreground">Действует с: {formatSingleDate(page.updatedAt)}</p>}
    {page.publication && <p className="mt-2 break-all text-xs text-muted-foreground">
      Редакция {page.publication.version} · {page.publication.textSha256}
    </p>}
  </>;
  return (
    <article className="mx-auto min-w-0 max-w-3xl px-4 py-14 sm:px-6">
      {titleOffset === null && <header>
        <h1 className="font-heading text-3xl font-semibold text-foreground sm:text-4xl">{page.title}</h1>
        {metadata}
      </header>}
      <div className={titleOffset === null ? "mt-8" : undefined}>
        <MarkdownContent value={page.content} headingComponents={{ h1: ({ children, node }) => (
          titleOffset !== null && node?.position?.start.offset === titleOffset
            ? <header>
                <h1 className="font-heading text-3xl font-semibold text-foreground sm:text-4xl">{children}</h1>
                {metadata}
              </header>
            : <h2 className="font-heading pt-2 text-xl font-semibold text-foreground">{children}</h2>
        ) }} />
      </div>
    </article>
  );
}
