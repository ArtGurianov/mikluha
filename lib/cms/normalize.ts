import type {
  DepartureDTO,
  LegalPageDTO,
  OrganizerDTO,
  RawContentSet,
  RawImageRef,
  ReportDTO,
  ReviewDTO,
  SeoDTO,
  SiteSettingsDTO,
  TourDTO,
  ContentSnapshot,
  ImageAsset,
} from "./types";

/**
 * A content file's fields are only as reliable as whatever last wrote it —
 * the Sveltia UI's `required: true` is an editor-side affordance, not a
 * guarantee about what's on disk, and files can also be hand-edited. Every
 * field a rendered page genuinely cannot do without is asserted here — at the
 * very start of the build, with the offending document named, rather than as
 * an `undefined is not an object` somewhere inside a React tree.
 */
function required<T>(value: T | undefined | null, what: string): T {
  if (value === undefined || value === null) {
    throw new Error(`Required content is missing: ${what}. Fix the document in the CMS and commit.`);
  }
  return value;
}

function requiredString(value: string | undefined | null, what: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Required content is missing: ${what}. Fix the document in the CMS and commit.`);
  }
  return value;
}

function optionalString(value: string | undefined | null): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/**
 * `image` is optional on every image field in the content model — an image
 * can be saved with only its alt text filled in, and the underlying asset can
 * be deleted from storage out from under a document that still references it.
 */
function image(ref: RawImageRef | undefined | null, what: string): ImageAsset {
  const src = requiredString(ref?.image, `${what} (image has no uploaded asset)`);
  return { alt: ref?.alt?.trim() || "", src };
}

/**
 * Optional images degrade to "not set" instead of failing the build: every
 * place one is actually load-bearing (an OPEN departure's payment QR, for
 * instance) is covered by scripts/validate-content.ts, which reports the
 * business consequence rather than a missing-asset stack trace.
 */
function maybeImage(ref: RawImageRef | undefined | null): ImageAsset | undefined {
  if (!ref?.image) return undefined;
  return { alt: ref.alt?.trim() || "", src: ref.image };
}

/**
 * `isListed`/`isDemo`/`launchReady` are all optional booleans in the stored
 * document (their CMS `default` is a create-time default, not a guarantee).
 * Both flags are resolved against their conservative reading: only an
 * explicit `true` publishes a document, marks it as demo content, or declares
 * the site launch-ready. Public visibility fails closed: a document that lost
 * the field to a content-model change, a bad hand-edit or an API write is
 * hidden rather than suddenly public, and a build never slips past the
 * launch gate because a flag was missing rather than set.
 */
function flag(value: boolean | undefined | null): boolean {
  return value === true;
}

/**
 * Every relation field (tour/departure/report/review references, etc.) points
 * at a document by its *filename* (`value_field: "{{slug}}"` in
 * public/admin/config.yml), while tours/reports/legalPages also expose their
 * slug as an editable field for routing (`/tours/<slug>/`, ...). The CMS's
 * `slug: "{{fields.slug}}"` collection template keeps the two identical at
 * creation time, but nothing stops a hand-edit of the `slug` field without
 * renaming the file — and that divergence wouldn't fail loudly: every
 * reference to the document would just silently start pointing at the old
 * filename. Catch it here, by name, the same way `required()` does for a
 * missing field.
 */
function requireSlugConsistency(raw: { _slug: string; slug: string | null }, kind: string): string {
  const slug = requiredString(raw.slug, `${kind} "${raw._slug}.yml" slug`);
  if (raw._slug !== slug) {
    throw new Error(
      `${kind} "${raw._slug}.yml": its \`slug\` field ("${slug}") doesn't match the filename. Every ` +
        `relation field points at the filename, not the slug field, so this document is now unreachable from ` +
        `anything that references it — rename the file to match, or fix the slug field.`,
    );
  }
  return slug;
}

function normalizeSeo(
  seo:
    | { title?: string | null; description?: string | null; image?: RawImageRef | null }
    | undefined
    | null,
): SeoDTO<ImageAsset> | undefined {
  if (!seo) return undefined;
  return { title: optionalString(seo.title), description: optionalString(seo.description), image: maybeImage(seo.image) };
}

export function normalizeContentSet(raw: RawContentSet, source: "git"): ContentSnapshot {
  const tours: TourDTO<ImageAsset>[] = raw.tours.map((t) => ({
    id: requireSlugConsistency(t, "Tour"),
    slug: requiredString(t.slug, `tour "${t._slug}" slug`),
    title: requiredString(t.title, `tour "${t._slug}" title`),
    shortDescription: requiredString(t.shortDescription, `tour "${t._slug}" shortDescription`),
    description: optionalString(t.description),
    coverImage: image(t.coverImage, `tour "${t.slug}" coverImage`),
    gallery: (t.gallery ?? []).map((g, i) => image(g, `tour "${t.slug}" gallery[${i}]`)),
    isListed: flag(t.isListed),
    sortOrder: t.sortOrder ?? 0,
    seo: normalizeSeo(t.seo),
  }));

  const departures: DepartureDTO<ImageAsset>[] = raw.departures.map((d) => ({
    id: d._slug,
    tourId: requiredString(d.tour, `departure "${d._slug}" tour`),
    startDate: requiredString(d.startDate, `departure "${d._slug}" startDate`),
    endDate: requiredString(d.endDate, `departure "${d._slug}" endDate`),
    bookingStatus: required(d.bookingStatus, `departure "${d._slug}" bookingStatus`),
    price: d.price ?? undefined,
    prepaymentAmount: d.prepaymentAmount ?? undefined,
    paymentQr: maybeImage(d.paymentQr),
    organizerIds: d.organizers ?? [],
    isListed: flag(d.isListed),
    isDemo: flag(d.isDemo),
  }));

  const departureById = new Map(departures.map((d) => [d.id, d]));

  const reports: ReportDTO<ImageAsset>[] = raw.reports.map((r) => {
    const departureId = optionalString(r.departure);
    const linkedDeparture = departureId ? departureById.get(departureId) : undefined;
    return {
      id: requireSlugConsistency(r, "Report"),
      slug: requiredString(r.slug, `report "${r._slug}" slug`),
      title: requiredString(r.title, `report "${r._slug}" title`),
      tourId: requiredString(r.tour, `report "${r._slug}" tour`),
      departureId,
      date: linkedDeparture?.startDate ?? optionalString(r.date),
      coverImage: image(r.coverImage, `report "${r.slug}" coverImage`),
      gallery: (r.gallery ?? []).map((g, i) => image(g, `report "${r.slug}" gallery[${i}]`)),
      description: optionalString(r.description),
      sortOrder: r.sortOrder ?? 0,
    };
  });

  const reviews: ReviewDTO<ImageAsset>[] = raw.reviews.map((rv) => ({
    id: rv._slug,
    image: image(rv.image, `review "${rv._slug}" image`),
    authorName: requiredString(rv.authorName, `review "${rv._slug}" authorName`),
    tourId: optionalString(rv.tour),
    description: optionalString(rv.description),
    sortOrder: rv.sortOrder ?? 0,
    isListed: flag(rv.isListed),
    isDemo: flag(rv.isDemo),
  }));

  const organizers: OrganizerDTO<ImageAsset>[] = raw.organizers.map((o) => ({
    id: o._slug,
    name: requiredString(o.name, `organizer "${o._slug}" name`),
    phone: requiredString(o.phone, `organizer "${o._slug}" phone`),
    photo: maybeImage(o.photo),
    bio: optionalString(o.bio),
    isListed: flag(o.isListed),
    isDemo: flag(o.isDemo),
  }));

  const legalPages: LegalPageDTO[] = raw.legalPages.map((p) => ({
    id: requireSlugConsistency(p, "LegalPage"),
    slug: requiredString(p.slug, `legalPage "${p._slug}" slug`),
    title: requiredString(p.title, `legalPage "${p._slug}" title`),
    content: requiredString(p.content, `legalPage "${p._slug}" content`),
    updatedAt: optionalString(p.updatedAt),
  }));

  const s = raw.siteSettings;
  // hero/company/seo are whole objects the site cannot render without; booking
  // is genuinely optional (every fallback inside it is), so an absent object
  // just means "no defaults configured".
  const hero = required(s.hero, "siteSettings.hero");
  const company = required(s.company, "siteSettings.company");
  const seo = required(s.seo, "siteSettings.seo");
  const booking = s.booking ?? {};

  const siteSettings: SiteSettingsDTO<ImageAsset> = {
    siteName: requiredString(s.siteName, "siteSettings.siteName"),
    siteUrl: requiredString(s.siteUrl, "siteSettings.siteUrl"),
    timezone: requiredString(s.timezone, "siteSettings.timezone"),
    logo: maybeImage(s.logo),
    hero: {
      title: requiredString(hero.title, "siteSettings.hero.title"),
      subtitle: optionalString(hero.subtitle),
      image: image(hero.image, "siteSettings.hero.image"),
      video: hero.video?.file ? { src: hero.video.file } : undefined,
    },
    booking: {
      defaultQr: maybeImage(booking.defaultQr),
      defaultPrepaymentAmount: booking.defaultPrepaymentAmount ?? undefined,
      defaultOrganizerId: optionalString(booking.defaultOrganizer),
      isDemo: flag(booking.isDemo),
    },
    socials: { maxChannelUrl: optionalString(s.socials?.maxChannelUrl) },
    company: {
      legalName: requiredString(company.legalName, "siteSettings.company.legalName"),
      inn: requiredString(company.inn, "siteSettings.company.inn"),
      ogrn: requiredString(company.ogrn, "siteSettings.company.ogrn"),
      phone: requiredString(company.phone, "siteSettings.company.phone"),
      email: optionalString(company.email),
      isDemo: flag(company.isDemo),
    },
    seo: {
      title: requiredString(seo.title, "siteSettings.seo.title"),
      description: requiredString(seo.description, "siteSettings.seo.description"),
      ogImage: maybeImage(seo.ogImage),
    },
    launchReady: flag(s.launchReady),
  };

  return {
    generatedAt: new Date().toISOString(),
    source,
    siteSettings,
    tours,
    departures,
    reports,
    reviews,
    organizers,
    legalPages,
  };
}
