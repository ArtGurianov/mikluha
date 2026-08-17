import ReactMarkdown, { defaultUrlTransform, type Components, type UrlTransform } from "react-markdown";
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

export function MarkdownContent({ value, className }: { value: string; className?: string }) {
  return (
    <div className={cn("space-y-4", className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components} urlTransform={urlTransform}>
        {value}
      </ReactMarkdown>
    </div>
  );
}
