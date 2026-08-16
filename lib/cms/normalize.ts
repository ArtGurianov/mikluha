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
  UnresolvedContentSnapshot,
  UnresolvedImageAsset,
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

/**
 * `image` is optional on every image field in the content model — an image
 * can be saved with only its alt text filled in, and the underlying asset can
 * be deleted from storage out from under a document that still references it.
 */
function image(ref: RawImageRef, what: string): UnresolvedImageAsset {
  const sourceRef = required(ref.image, `${what} (image has no uploaded asset)`);
  return { alt: ref.alt?.trim() || "", sourceRef };
}

/**
 * Optional images degrade to "not set" instead of failing the build: every
 * place one is actually load-bearing (an OPEN departure's payment QR, for
 * instance) is covered by scripts/validate-content.ts, which reports the
 * business consequence rather than a missing-asset stack trace.
 */
function maybeImage(ref: RawImageRef | undefined): UnresolvedImageAsset | undefined {
  if (!ref?.image) return undefined;
  return { alt: ref.alt?.trim() || "", sourceRef: ref.image };
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
function flag(value: boolean | undefined): boolean {
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
function requireSlugConsistency(raw: { _slug: string; slug: string }, kind: string): string {
  if (raw._slug !== raw.slug) {
    throw new Error(
      `${kind} "${raw._slug}.yml": its \`slug\` field ("${raw.slug}") doesn't match the filename. Every ` +
        `relation field points at the filename, not the slug field, so this document is now unreachable from ` +
        `anything that references it — rename the file to match, or fix the slug field.`,
    );
  }
  return raw.slug;
}

function normalizeSeo(
  seo: { title?: string; description?: string; image?: RawImageRef } | undefined,
): SeoDTO<UnresolvedImageAsset> | undefined {
  if (!seo) return undefined;
  return { title: seo.title, description: seo.description, image: maybeImage(seo.image) };
}

export function normalizeContentSet(raw: RawContentSet, source: "git"): UnresolvedContentSnapshot {
  const tours: TourDTO<UnresolvedImageAsset>[] = raw.tours.map((t) => ({
    id: requireSlugConsistency(t, "Tour"),
    slug: t.slug,
    title: t.title,
    shortDescription: t.shortDescription,
    description: t.description,
    coverImage: image(t.coverImage, `tour "${t.slug}" coverImage`),
    gallery: (t.gallery ?? []).map((g, i) => image(g, `tour "${t.slug}" gallery[${i}]`)),
    isListed: flag(t.isListed),
    sortOrder: t.sortOrder ?? 0,
    seo: normalizeSeo(t.seo),
  }));

  const departures: DepartureDTO<UnresolvedImageAsset>[] = raw.departures.map((d) => ({
    id: d._slug,
    tourId: d.tour,
    startDate: d.startDate,
    endDate: d.endDate,
    bookingStatus: d.bookingStatus,
    price: d.price,
    prepaymentAmount: d.prepaymentAmount,
    paymentQr: maybeImage(d.paymentQr),
    organizerIds: d.organizers ?? [],
    isListed: flag(d.isListed),
    isDemo: flag(d.isDemo),
  }));

  const departureById = new Map(departures.map((d) => [d.id, d]));

  const reports: ReportDTO<UnresolvedImageAsset>[] = raw.reports.map((r) => {
    const linkedDeparture = r.departure ? departureById.get(r.departure) : undefined;
    return {
      id: requireSlugConsistency(r, "Report"),
      slug: r.slug,
      title: r.title,
      tourId: r.tour,
      departureId: r.departure,
      date: linkedDeparture?.startDate ?? r.date,
      coverImage: image(r.coverImage, `report "${r.slug}" coverImage`),
      gallery: (r.gallery ?? []).map((g, i) => image(g, `report "${r.slug}" gallery[${i}]`)),
      description: r.description,
      sortOrder: r.sortOrder ?? 0,
    };
  });

  const reviews: ReviewDTO<UnresolvedImageAsset>[] = raw.reviews.map((rv) => ({
    id: rv._slug,
    image: image(rv.image, `review "${rv._slug}" image`),
    authorName: rv.authorName,
    tourId: rv.tour,
    description: rv.description,
    sortOrder: rv.sortOrder ?? 0,
    isListed: flag(rv.isListed),
    isDemo: flag(rv.isDemo),
  }));

  const organizers: OrganizerDTO<UnresolvedImageAsset>[] = raw.organizers.map((o) => ({
    id: o._slug,
    name: o.name,
    phone: o.phone,
    photo: maybeImage(o.photo),
    bio: o.bio,
    isListed: flag(o.isListed),
    isDemo: flag(o.isDemo),
  }));

  const legalPages: LegalPageDTO[] = raw.legalPages.map((p) => ({
    id: requireSlugConsistency(p, "LegalPage"),
    slug: p.slug,
    title: p.title,
    content: p.content,
    updatedAt: p.updatedAt,
  }));

  const s = raw.siteSettings;
  // hero/company/seo are whole objects the site cannot render without; booking
  // is genuinely optional (every fallback inside it is), so an absent object
  // just means "no defaults configured".
  const hero = required(s.hero, "siteSettings.hero");
  const company = required(s.company, "siteSettings.company");
  const seo = required(s.seo, "siteSettings.seo");
  const booking = s.booking ?? {};

  const siteSettings: SiteSettingsDTO<UnresolvedImageAsset> = {
    siteName: s.siteName,
    siteUrl: s.siteUrl,
    timezone: s.timezone,
    logo: maybeImage(s.logo),
    favicon: maybeImage(s.favicon),
    hero: { title: hero.title, subtitle: hero.subtitle, image: image(hero.image, "siteSettings.hero.image") },
    booking: {
      defaultQr: maybeImage(booking.defaultQr),
      defaultPrepaymentAmount: booking.defaultPrepaymentAmount,
      defaultOrganizerId: booking.defaultOrganizer,
      isDemo: flag(booking.isDemo),
    },
    socials: { maxChannelUrl: s.socials?.maxChannelUrl },
    company: {
      legalName: company.legalName,
      inn: company.inn,
      ogrn: company.ogrn,
      phone: company.phone,
      email: company.email,
      isDemo: flag(company.isDemo),
    },
    seo: { title: seo.title, description: seo.description, ogImage: maybeImage(seo.ogImage) },
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
