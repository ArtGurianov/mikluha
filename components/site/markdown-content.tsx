import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

import { cn } from "@/lib/utils";

const components: Components = {
  p: ({ children }) => <p className="leading-relaxed text-foreground/90">{children}</p>,
  h2: ({ children }) => <h2 className="font-heading pt-2 text-xl font-semibold text-foreground">{children}</h2>,
  h3: ({ children }) => <h3 className="font-heading pt-2 text-lg font-semibold text-foreground">{children}</h3>,
  ul: ({ children }) => <ul className="list-disc space-y-1.5 pl-5 text-foreground/90">{children}</ul>,
  ol: ({ children }) => <ol className="list-decimal space-y-1.5 pl-5 text-foreground/90">{children}</ol>,
  a: ({ children, href }) => (
    <a href={href} target="_blank" rel="noreferrer noopener" className="underline underline-offset-4 hover:text-foreground">
      {children}
    </a>
  ),
};

export function MarkdownContent({ value, className }: { value: string; className?: string }) {
  return (
    <div className={cn("space-y-4", className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {value}
      </ReactMarkdown>
    </div>
  );
}
