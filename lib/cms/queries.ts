/**
 * GROQ queries used by scripts/sync-sanity-content.ts to pull the published
 * content set from Sanity. References are left unresolved (`_ref` only) —
 * cross-linking happens during normalization so the same logic works whether
 * the raw documents came from Sanity or from local fixtures.
 *
 * Deliberately NOT filtering on `isListed` here: it's a soft visibility flag
 * (PRD §23/§26/§27), not a publication state, and a hidden tour/departure may
 * still be legitimately referenced by a report/review that IS listed. All
 * public rendering call sites (lib/tours.ts, OrganizerSection, ...) already
 * filter on `isListed` themselves — filtering twice, once here and once
 * app-side, would make toggling a document's visibility off break the next
 * build the moment anything else still points at it.
 */

export const siteSettingsQuery = /* groq */ `*[_type == "siteSettings" && _id == "siteSettings"][0]`;

export const toursQuery = /* groq */ `*[_type == "tour"] | order(sortOrder asc, title asc)`;

export const departuresQuery = /* groq */ `*[_type == "departure"] | order(startDate asc)`;

export const reportsQuery = /* groq */ `*[_type == "report"] | order(sortOrder asc, coalesce(date, "") desc)`;

export const reviewsQuery = /* groq */ `*[_type == "review"] | order(sortOrder asc)`;

export const organizersQuery = /* groq */ `*[_type == "organizer"]`;

export const legalPagesQuery = /* groq */ `*[_type == "legalPage"]`;
