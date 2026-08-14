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

function image(ref: RawImageRef): UnresolvedImageAsset {
  return { alt: ref.alt?.trim() || "", sourceRef: ref.asset._ref };
}

function maybeImage(ref: RawImageRef | undefined): UnresolvedImageAsset | undefined {
  return ref ? image(ref) : undefined;
}

function normalizeSeo(seo: { title?: string; description?: string; image?: RawImageRef } | undefined): SeoDTO<UnresolvedImageAsset> | undefined {
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
    coverImage: image(t.coverImage),
    gallery: (t.gallery ?? []).map(image),
    isListed: t.isListed,
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
    isListed: d.isListed,
    isDemo: d.isDemo,
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
      coverImage: image(r.coverImage),
      gallery: (r.gallery ?? []).map(image),
      description: r.description,
      sortOrder: r.sortOrder ?? 0,
    };
  });

  const reviews: ReviewDTO<UnresolvedImageAsset>[] = raw.reviews.map((rv) => ({
    id: rv._id,
    image: image(rv.image),
    authorName: rv.authorName,
    tourId: rv.tour?._ref,
    description: rv.description,
    sortOrder: rv.sortOrder ?? 0,
    isListed: rv.isListed,
    isDemo: rv.isDemo,
  }));

  const organizers: OrganizerDTO<UnresolvedImageAsset>[] = raw.organizers.map((o) => ({
    id: o._id,
    name: o.name,
    phone: o.phone,
    photo: maybeImage(o.photo),
    bio: o.bio,
    isListed: o.isListed,
    isDemo: o.isDemo,
  }));

  const legalPages: LegalPageDTO[] = raw.legalPages.map((p) => ({
    id: p._id,
    slug: p.slug.current,
    title: p.title,
    content: p.content,
    updatedAt: p.updatedAt,
  }));

  const s = raw.siteSettings;
  const siteSettings: SiteSettingsDTO<UnresolvedImageAsset> = {
    siteName: s.siteName,
    siteUrl: s.siteUrl,
    timezone: s.timezone,
    logo: maybeImage(s.logo),
    favicon: maybeImage(s.favicon),
    hero: { title: s.hero.title, subtitle: s.hero.subtitle, image: image(s.hero.image) },
    booking: {
      defaultQr: maybeImage(s.booking.defaultQr),
      defaultPrepaymentAmount: s.booking.defaultPrepaymentAmount,
      defaultOrganizerId: s.booking.defaultOrganizer?._ref,
      isDemo: s.booking.isDemo,
    },
    socials: { maxChannelUrl: s.socials?.maxChannelUrl },
    company: {
      legalName: s.company.legalName,
      inn: s.company.inn,
      ogrn: s.company.ogrn,
      phone: s.company.phone,
      email: s.company.email,
      isDemo: s.company.isDemo,
    },
    seo: { title: s.seo.title, description: s.seo.description, ogImage: maybeImage(s.seo.ogImage) },
    launchReady: s.launchReady,
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
