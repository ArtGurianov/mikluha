/**
 * The SSR site's view of the Commerce public projection (ADR v2.3 §2, TOUR-60):
 * GET /public/v1/catalog, commerce/src/public-api.ts. Published, listed
 * content only, fetched once per request, never cached.
 *
 * Each projection row maps onto the same Raw* shape a content/ YAML file has,
 * so ./normalize.ts stays the one place that decides what a page may render:
 * the projection's own columns (slug, relations, dates, price, flags) win over
 * anything an editor put into the free-form `content` document, which carries
 * the rest of the fields (heading, description, images, SEO, phone, ...).
 */
import type {
  RawDeparture,
  RawDepartureContract,
  RawOrganizer,
  RawReport,
  RawReview,
  RawTour,
  RawTourContract,
} from "./types";

export const PUBLIC_CATALOG_SCHEMA = "mikluha.public-catalog/1";
const FETCH_TIMEOUT_MS = 5_000;

type Doc = Record<string, unknown>;

interface CommerceTourContract {
  destination: string;
  route: string;
  program: { title: string; items: string[] }[];
  included: string[];
  excluded: string[];
  insurance: string | null;
  risks: string;
}

type CommerceDepartureContract = Omit<RawDepartureContract, "product" | "services"> & {
  services: { name: string; supplier: string; included: boolean; note: string | null }[];
};

/** Only the fields this site reads; Commerce owns the full shape. */
export interface PublicCatalog {
  schema: typeof PUBLIC_CATALOG_SCHEMA;
  tours: { slug: string; title: string; content: Doc }[];
  departures: {
    slug: string;
    tourSlug: string;
    startsOn: string;
    endsOn: string;
    bookingStatus: "OPEN" | "CLOSED" | "CANCELLED";
    priceKopecks: number | null;
    capacity: number | null;
    contract: { tour: CommerceTourContract; departure: CommerceDepartureContract } | null;
    isDemo: boolean;
    content: Doc;
    organizers: string[];
  }[];
  organizers: { slug: string; name: string; isDemo: boolean; content: Doc }[];
  reports: {
    slug: string;
    title: string;
    tourSlug: string;
    departureSlug: string | null;
    date: string | null;
    noindex: boolean;
    content: Doc;
  }[];
  reviews: { slug: string; authorName: string; tourSlug: string | null; isDemo: boolean; content: Doc }[];
}

export interface RawCatalog {
  tours: RawTour[];
  departures: RawDeparture[];
  reports: RawReport[];
  reviews: RawReview[];
  organizers: RawOrganizer[];
}

const COLLECTIONS = ["tours", "departures", "organizers", "reports", "reviews"] as const;

export function parsePublicCatalog(value: unknown): PublicCatalog {
  const v = value as Partial<Record<string, unknown>> | null;
  if (v === null || typeof v !== "object" || v.schema !== PUBLIC_CATALOG_SCHEMA
    || COLLECTIONS.some((key) => !Array.isArray(v[key]))) {
    throw new Error("PUBLIC_CATALOG_INVALID");
  }
  return v as unknown as PublicCatalog;
}

/** Commerce keeps lists as arrays; the site's contract fields are one item per line, as in the YAML. */
const lines = (items: readonly string[]) => items.join("\n");

function tourContract(c: CommerceTourContract): RawTourContract {
  return {
    destination: c.destination,
    route: c.route,
    program: c.program.map((day) => ({ title: day.title, items: lines(day.items) })),
    included: lines(c.included),
    excluded: lines(c.excluded),
    insurance: c.insurance,
    risks: c.risks,
  };
}

export function projectionToRaw(catalog: PublicCatalog): RawCatalog {
  return {
    tours: catalog.tours.map((t) => ({
      ...(t.content as Partial<RawTour>),
      slug: t.slug,
      title: t.title,
      isListed: true,
      _slug: t.slug,
    }) as RawTour),
    departures: catalog.departures.map((d) => ({
      ...(d.content as Partial<RawDeparture>),
      tour: d.tourSlug,
      startDate: d.startsOn,
      endDate: d.endsOn,
      bookingStatus: d.bookingStatus,
      price: d.priceKopecks === null ? null : d.priceKopecks / 100,
      capacity: d.capacity,
      // Commerce offers a contract only when the database found it complete; otherwise none.
      contract: d.contract === null ? null : { ...d.contract.departure, product: tourContract(d.contract.tour) },
      organizers: d.organizers,
      isListed: true,
      isDemo: d.isDemo,
      _slug: d.slug,
    })),
    organizers: catalog.organizers.map((o) => ({
      ...(o.content as Partial<RawOrganizer>),
      name: o.name,
      isListed: true,
      isDemo: o.isDemo,
      _slug: o.slug,
    }) as RawOrganizer),
    reports: catalog.reports.map((r) => ({
      ...(r.content as Partial<RawReport>),
      slug: r.slug,
      title: r.title,
      tour: r.tourSlug,
      departure: r.departureSlug,
      date: r.date,
      noindex: r.noindex,
      _slug: r.slug,
    }) as RawReport),
    reviews: catalog.reviews.map((rv) => ({
      ...(rv.content as Partial<RawReview>),
      authorName: rv.authorName,
      tour: rv.tourSlug,
      isListed: true,
      isDemo: rv.isDemo,
      _slug: rv.slug,
    }) as RawReview),
  };
}

/**
 * The internal Commerce address (`COMMERCE_PUBLIC_API_URL`, e.g.
 * http://mikluha-commerce:3000), read at request time. A missing or failing
 * Commerce throws: the page renders its error state, never stale prices.
 */
export async function fetchPublicCatalog(
  base: string | undefined = process.env.COMMERCE_PUBLIC_API_URL,
): Promise<PublicCatalog> {
  if (!base) throw new Error("COMMERCE_PUBLIC_API_URL is not set");
  const res = await fetch(new URL("/public/v1/catalog", base), {
    cache: "no-store",
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (res.status !== 200) throw new Error(`PUBLIC_CATALOG_UNAVAILABLE: ${res.status}`);
  return parsePublicCatalog(await res.json());
}
