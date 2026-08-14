/**
 * GROQ queries used by scripts/sync-sanity-content.ts to pull the published
 * content set from Sanity. References are left unresolved (`_ref` only) —
 * cross-linking happens during normalization so the same logic works whether
 * the raw documents came from Sanity or from local fixtures.
 *
 * Deliberately NOT filtering on `isListed` here: it's a soft visibility flag
 *, not a publication state, and a hidden tour/departure may
 * still be legitimately referenced by a report/review that IS listed. All
 * public rendering call sites (lib/tours.ts, OrganizerSection, ...) already
 * filter on `isListed` themselves — filtering twice, once here and once
 * app-side, would make toggling a document's visibility off break the next
 * build the moment anything else still points at it.
 *
 * Every query MUST be wrapped in `defineQuery` — that is what Sanity TypeGen
 * scans for (see sanity-typegen.json). It generates a `<name>Result` type per
 * query AND a module augmentation that types `client.fetch(query)` at the call
 * site, so the raw Sanity response shape is checked against the real schema
 * instead of silently arriving as `any`.
 */
import { defineQuery } from "groq";

export const siteSettingsQuery = defineQuery(`*[_type == "siteSettings" && _id == "siteSettings"][0]`);

export const toursQuery = defineQuery(`*[_type == "tour"] | order(sortOrder asc, title asc)`);

export const departuresQuery = defineQuery(`*[_type == "departure"] | order(startDate asc)`);

export const reportsQuery = defineQuery(`*[_type == "report"] | order(sortOrder asc, coalesce(date, "") desc)`);

export const reviewsQuery = defineQuery(`*[_type == "review"] | order(sortOrder asc)`);

export const organizersQuery = defineQuery(`*[_type == "organizer"]`);

export const legalPagesQuery = defineQuery(`*[_type == "legalPage"]`);
