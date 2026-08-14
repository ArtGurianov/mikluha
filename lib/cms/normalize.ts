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
 * Sanity never guarantees a field just because the Studio marks it required:
 * `validation` rules are editor-side affordances that aren't part of the stored
 * document, and content can also be written through the API. The generated
 * types (see ./types.ts) reflect that honestly, so everything a rendered page
 * genuinely cannot do without is asserted here — at the very start of the
 * build, with the offending document named, rather than as a `undefined is not
 * an object` somewhere inside a React tree.
 */
function required<T>(value: T | undefined | null, what: string): T {
  if (value === undefined || value === null) {
    throw new Error(`Required content is missing: ${what}. Fix the document in Sanity Studio and republish.`);
  }
  return value;
}

/**
 * `image.asset` is optional on every image field in the schema — an image can
 * be saved with only its alt text filled in, and an asset can be deleted out
 * from under a document that still references it.
 */
function image(ref: RawImageRef, what: string): UnresolvedImageAsset {
  const assetRef = required(ref.asset?._ref, `${what} (image has no uploaded asset)`);
  return { alt: ref.alt?.trim() || "", sourceRef: assetRef };
}

/**
 * Optional images degrade to "not set" instead of failing the build: every
 * place one is actually load-bearing (an OPEN departure's payment QR, for
 * instance) is covered by scripts/validate-content.ts, which reports the
 * business consequence rather than a missing-asset stack trace.
 */
function maybeImage(ref: RawImageRef | undefined): UnresolvedImageAsset | undefined {
  if (!ref?.asset?._ref) return undefined;
  return { alt: ref.alt?.trim() || "", sourceRef: ref.asset._ref };
}

/**
 * `isListed`/`isDemo`/`launchReady` are all optional booleans in the stored
 * document (their Studio `initialValue` is a create-time default, not a
 * guarantee). Both flags are resolved against their conservative reading:
 * only an explicit `true` publishes a document, marks it as demo content, or
 * declares the site launch-ready. Public visibility fails closed: a document
 * that lost the field to a schema migration, a bad import script or an API
 * write is hidden rather than suddenly public, and a build never slips past
 * the launch gate because a flag was missing rather than set.
 */
function flag(value: boolean | undefined): boolean {
  return value === true;
}

function normalizeSeo(
  seo: { title?: string; description?: string; image?: RawImageRef } | undefined,
): SeoDTO<UnresolvedImageAsset> | undefined {
  if (!seo) return undefined;
  return { title: seo.title, description: seo.description, image: maybeImage(seo.image) };
}

export function normalizeContentSet(raw: RawContentSet, source: "sanity" | "fixtures"): UnresolvedContentSnapshot {
  const tours: TourDTO<UnresolvedImageAsset>[] = raw.tours.map((t) => ({
    id: t._id,
    slug: t.slug.current,
    title: t.title,
    shortDescription: t.shortDescription,
    description: t.description,
    coverImage: image(t.coverImage, `tour "${t.slug.current}" coverImage`),
    gallery: (t.gallery ?? []).map((g, i) => image(g, `tour "${t.slug.current}" gallery[${i}]`)),
    isListed: flag(t.isListed),
    sortOrder: t.sortOrder ?? 0,
    seo: normalizeSeo(t.seo),
  }));

  const departures: DepartureDTO<UnresolvedImageAsset>[] = raw.departures.map((d) => ({
    id: d._id,
    tourId: d.tour._ref,
    startDate: d.startDate,
    endDate: d.endDate,
    bookingStatus: d.bookingStatus,
    price: d.price,
    prepaymentAmount: d.prepaymentAmount,
    paymentQr: maybeImage(d.paymentQr),
    organizerIds: (d.organizers ?? []).map((o) => o._ref),
    isListed: flag(d.isListed),
    isDemo: flag(d.isDemo),
  }));

  const departureById = new Map(departures.map((d) => [d.id, d]));

  const reports: ReportDTO<UnresolvedImageAsset>[] = raw.reports.map((r) => {
    const linkedDeparture = r.departure ? departureById.get(r.departure._ref) : undefined;
    return {
      id: r._id,
      slug: r.slug.current,
      title: r.title,
      tourId: r.tour._ref,
      departureId: r.departure?._ref,
      date: linkedDeparture?.startDate ?? r.date,
      coverImage: image(r.coverImage, `report "${r.slug.current}" coverImage`),
      gallery: (r.gallery ?? []).map((g, i) => image(g, `report "${r.slug.current}" gallery[${i}]`)),
      description: r.description,
      sortOrder: r.sortOrder ?? 0,
    };
  });

  const reviews: ReviewDTO<UnresolvedImageAsset>[] = raw.reviews.map((rv) => ({
    id: rv._id,
    image: image(rv.image, `review "${rv._id}" image`),
    authorName: rv.authorName,
    tourId: rv.tour?._ref,
    description: rv.description,
    sortOrder: rv.sortOrder ?? 0,
    isListed: flag(rv.isListed),
    isDemo: flag(rv.isDemo),
  }));

  const organizers: OrganizerDTO<UnresolvedImageAsset>[] = raw.organizers.map((o) => ({
    id: o._id,
    name: o.name,
    phone: o.phone,
    photo: maybeImage(o.photo),
    bio: o.bio,
    isListed: flag(o.isListed),
    isDemo: flag(o.isDemo),
  }));

  const legalPages: LegalPageDTO[] = raw.legalPages.map((p) => ({
    id: p._id,
    slug: p.slug.current,
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
      defaultOrganizerId: booking.defaultOrganizer?._ref,
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
