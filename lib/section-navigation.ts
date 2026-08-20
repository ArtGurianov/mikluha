/**
 * Returns the decoded section id only when a link points at the exact URL
 * already shown in the address bar. Browsers do not emit a new hash change in
 * that case, so the caller has to repeat the scroll explicitly.
 */
export function getRepeatedSectionId(currentHref: string, targetHref: string): string | undefined {
  try {
    const current = new URL(currentHref);
    const target = new URL(targetHref, current);

    if (
      !target.hash ||
      target.origin !== current.origin ||
      target.pathname !== current.pathname ||
      target.search !== current.search ||
      target.hash !== current.hash
    ) {
      return undefined;
    }

    const encodedId = target.hash.slice(1);
    if (!encodedId) return undefined;

    try {
      return decodeURIComponent(encodedId);
    } catch {
      return encodedId;
    }
  } catch {
    return undefined;
  }
}

export function scrollToRepeatedSection(
  currentHref: string,
  targetHref: string,
  findSection: (id: string) => Pick<Element, "scrollIntoView"> | null,
): boolean {
  const sectionId = getRepeatedSectionId(currentHref, targetHref);
  if (!sectionId) return false;

  const section = findSection(sectionId);
  if (!section) return false;

  section.scrollIntoView();
  return true;
}
