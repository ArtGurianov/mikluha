import type { DepartureDTO, ReportDTO, SiteSettingsDTO, TourDTO } from "./cms/types";

/**
 * Schema.org JSON-LD builders. Pure functions of the content snapshot and the
 * canonical base, so the markup is testable and every page links to the same
 * organization node by `@id` instead of repeating it.
 *
 * Deliberately no `Event`: Google's Event guidelines exclude trip packages, so
 * a departure is described as a `TouristTrip` sub-trip with an `Offer`. That
 * is plain schema.org semantics (Yandex and other consumers read it), not a
 * Google rich result — the organization and breadcrumbs are what search
 * results actually render.
 */

/** Resolves a site path ("/tours/altai/") or an already-absolute media URL against the canonical base. */
export function absoluteUrl(pathOrUrl: string, base: string): string {
  return new URL(pathOrUrl, base).href;
}

export function organizationId(base: string): string {
  return absoluteUrl("/#organization", base);
}

export function buildOrganizationJsonLd(siteSettings: SiteSettingsDTO, base: string) {
  const { company, socials, logo, seo } = siteSettings;
  return {
    "@context": "https://schema.org",
    "@type": "TravelAgency",
    "@id": organizationId(base),
    name: siteSettings.siteName,
    legalName: company.legalName,
    url: absoluteUrl("/", base),
    ...(logo ? { logo: absoluteUrl(logo.src, base) } : {}),
    ...(seo.ogImage ? { image: absoluteUrl(seo.ogImage.src, base) } : {}),
    telephone: company.phone,
    ...(company.email ? { email: company.email } : {}),
    // Locality only: there is no public office, and a street address must not
    // be invented for ranking purposes.
    ...(company.city
      ? { address: { "@type": "PostalAddress", addressLocality: company.city, addressCountry: "RU" } }
      : {}),
    taxID: company.inn,
    identifier: { "@type": "PropertyValue", propertyID: "ОГРН", value: company.ogrn },
    ...(socials.maxChannelUrl ? { sameAs: [socials.maxChannelUrl] } : {}),
  };
}

/** One step of a breadcrumb trail; `path` is a site path, never a fragment. */
export interface Crumb {
  name: string;
  path: string;
}

const HOME_CRUMB: Crumb = { name: "Главная", path: "/" };

export function getTourBreadcrumbs(tour: TourDTO): Crumb[] {
  return [HOME_CRUMB, { name: tour.title, path: `/tours/${tour.slug}/` }];
}

/** A hidden tour has no page to link to, so the report then hangs directly off the home page. */
export function getReportBreadcrumbs(report: ReportDTO, tour: TourDTO | undefined): Crumb[] {
  return [
    HOME_CRUMB,
    ...(tour?.isListed ? [{ name: tour.title, path: `/tours/${tour.slug}/` }] : []),
    { name: report.title, path: `/reports/${report.slug}/` },
  ];
}

export function buildBreadcrumbJsonLd(crumbs: Crumb[], base: string) {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: crumbs.map((crumb, index) => ({
      "@type": "ListItem",
      position: index + 1,
      name: crumb.name,
      item: absoluteUrl(crumb.path, base),
    })),
  };
}

/**
 * A tour as a `TouristTrip`, with the departures the page actually shows as
 * dated sub-trips. Pass only what is visible (the nearest departure) — marking
 * up dates and prices a visitor cannot see on the page is against both
 * Google's and Yandex's structured-data rules.
 */
export function buildTouristTripJsonLd(tour: TourDTO, departures: DepartureDTO[], base: string) {
  const url = absoluteUrl(`/tours/${tour.slug}/`, base);
  return {
    "@context": "https://schema.org",
    "@type": "TouristTrip",
    "@id": `${url}#trip`,
    name: tour.heading ?? tour.title,
    description: tour.shortDescription,
    url,
    image: [absoluteUrl(tour.coverImage.src, base)],
    provider: { "@id": organizationId(base) },
    ...(departures.length > 0
      ? {
          subTrip: departures.map((departure) => ({
            "@type": "Trip",
            name: tour.title,
            departureTime: departure.startDate,
            arrivalTime: departure.endDate,
            ...(departure.price !== undefined
              ? {
                  offers: {
                    "@type": "Offer",
                    price: departure.price,
                    priceCurrency: "RUB",
                    availability:
                      departure.bookingStatus === "OPEN" ? "https://schema.org/InStock" : "https://schema.org/SoldOut",
                    url,
                  },
                }
              : {}),
          })),
        }
      : {}),
  };
}
