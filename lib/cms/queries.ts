/**
 * GROQ queries used by scripts/sync-sanity-content.ts to pull the published
 * content set from Sanity. References are left unresolved (`_ref` only) —
 * cross-linking happens during normalization so the same logic works whether
 * the raw documents came from Sanity or from local fixtures.
 */

export const siteSettingsQuery = /* groq */ `*[_type == "siteSettings" && _id == "siteSettings"][0]`;

export const toursQuery = /* groq */ `*[_type == "tour" && isListed == true] | order(sortOrder asc, title asc)`;

export const departuresQuery = /* groq */ `*[_type == "departure" && isListed == true] | order(startDate asc)`;

export const reportsQuery = /* groq */ `*[_type == "report"] | order(sortOrder asc, coalesce(date, "") desc)`;

export const reviewsQuery = /* groq */ `*[_type == "review" && isListed == true] | order(sortOrder asc)`;

export const organizersQuery = /* groq */ `*[_type == "organizer" && isListed == true]`;

export const legalPagesQuery = /* groq */ `*[_type == "legalPage"]`;
