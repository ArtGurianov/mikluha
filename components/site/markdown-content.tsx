import ReactMarkdown, { defaultUrlTransform, type Components, type UrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";

import { cn } from "@/lib/utils";

const components: Components = {
  h1: ({ children }) => <h1 className="font-heading text-3xl font-semibold text-foreground sm:text-4xl">{children}</h1>,
  p: ({ children }) => <p className="leading-relaxed text-foreground/90">{children}</p>,
  h2: ({ children }) => <h2 className="font-heading pt-2 text-xl font-semibold text-foreground">{children}</h2>,
  h3: ({ children }) => <h3 className="font-heading pt-2 text-lg font-semibold text-foreground">{children}</h3>,
  ul: ({ children }) => <ul className="list-disc space-y-1.5 pl-5 text-foreground/90">{children}</ul>,
  ol: ({ children }) => <ol className="list-decimal space-y-1.5 pl-5 text-foreground/90">{children}</ol>,
  table: ({ children }) => (
    <div role="region" aria-label="Таблица документа" tabIndex={0}
      className="max-w-full scroll-mt-24 overflow-x-auto rounded-md border border-border focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
      <table className="w-full min-w-[40rem] table-fixed border-collapse text-left text-sm leading-relaxed">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="bg-muted">{children}</thead>,
  th: ({ children }) => <th scope="col" className="border border-border px-3 py-2 align-top font-semibold [overflow-wrap:anywhere]">{children}</th>,
  td: ({ children }) => <td className="border border-border px-3 py-3 align-top [overflow-wrap:anywhere]">{children}</td>,
  a: ({ children, href }) => (
    <a href={href} target="_blank" rel="noreferrer noopener" className="underline underline-offset-4 hover:text-foreground">
      {children}
    </a>
  ),
  img: ({ src }) => {
    throw new Error(
      `Unsupported inline Markdown image source "${typeof src === "string" ? src : ""}". ` +
        "Use a structured CMS image field.",
    );
  },
};

const urlTransform: UrlTransform = (url, _key, node) => {
  // Preserve the original image source long enough for the component guard to
  // report unsafe/custom schemes such as `local:`. Keep react-markdown's safe
  // default for links and every other URL-bearing element.
  if (node.tagName === "img") return url;
  return defaultUrlTransform(url);
};

export function MarkdownContent({ value, className, headingComponents }: {
  value: string;
  className?: string;
  headingComponents?: Pick<Components, "h1">;
}) {
  return (
    <div className={cn("space-y-4", className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ ...components, ...headingComponents }} urlTransform={urlTransform}>
        {value}
      </ReactMarkdown>
    </div>
  );
}
