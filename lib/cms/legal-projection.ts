import { createHash } from "node:crypto";

import { RESERVED_SLUGS, SLUG_RE } from "../legal";
import type { LegalPageDTO } from "./types";

/** The active, OWNER-approved rows of Commerce public_legal, never Git text. */
export function parsePublicLegalPages(value: unknown): LegalPageDTO[] {
  if (!Array.isArray(value)) throw new Error("PUBLIC_LEGAL_INVALID");
  const slugs = new Set<string>();
  return value.map((row) => {
    const p = row as Record<string, unknown> | null;
    if (!p || typeof p !== "object" || typeof p.slug !== "string" || !SLUG_RE.test(p.slug)
      || (RESERVED_SLUGS as readonly string[]).includes(p.slug) || slugs.has(p.slug)
      || typeof p.title !== "string" || !p.title.trim() || typeof p.body !== "string" || !p.body.trim()
      || !Number.isSafeInteger(p.publishedVersion) || Number(p.publishedVersion) < 1
      || typeof p.documentSha256 !== "string" || !/^sha256:[a-f0-9]{64}$/.test(p.documentSha256)
      || typeof p.effectiveOn !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(p.effectiveOn)
      || new Date(`${p.effectiveOn}T00:00:00Z`).toISOString().slice(0, 10) !== p.effectiveOn
      || p.effectiveOn > new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Moscow" }).format(new Date())
      || p.textSha256 !== `sha256:${createHash("sha256").update(p.body, "utf8").digest("hex")}`) {
      throw new Error("PUBLIC_LEGAL_INVALID");
    }
    slugs.add(p.slug);
    return { id: p.slug, slug: p.slug, title: p.title, content: p.body, updatedAt: p.effectiveOn,
      publication: { version: Number(p.publishedVersion), documentSha256: p.documentSha256, textSha256: p.textSha256 as string } };
  });
}
