import { PortableText, type PortableTextComponents } from "@portabletext/react";

import type { PortableTextBlocks } from "@/lib/cms/types";
import { cn } from "@/lib/utils";

const components: PortableTextComponents = {
  block: {
    normal: ({ children }) => <p className="leading-relaxed text-foreground/90">{children}</p>,
    h2: ({ children }) => <h2 className="font-heading pt-2 text-xl font-semibold text-foreground">{children}</h2>,
    h3: ({ children }) => <h3 className="font-heading pt-2 text-lg font-semibold text-foreground">{children}</h3>,
  },
  list: {
    bullet: ({ children }) => <ul className="list-disc space-y-1.5 pl-5 text-foreground/90">{children}</ul>,
    number: ({ children }) => <ol className="list-decimal space-y-1.5 pl-5 text-foreground/90">{children}</ol>,
  },
  marks: {
    link: ({ children, value }) => (
      <a
        href={value?.href}
        target="_blank"
        rel="noreferrer noopener"
        className="underline underline-offset-4 hover:text-foreground"
      >
        {children}
      </a>
    ),
  },
};

export function PortableTextContent({ value, className }: { value: PortableTextBlocks; className?: string }) {
  return (
    <div className={cn("space-y-4", className)}>
      <PortableText value={value as never} components={components} />
    </div>
  );
}
