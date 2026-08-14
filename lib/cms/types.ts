/**
 * The CMS integration boundary (PRD §39).
 *
 * `Raw*` = what Sanity actually returns. These are NOT hand-written: they are
 * derived from lib/cms/generated/sanity.types.ts, which `npm run cms:types`
 * generates from sanity/schemaTypes/* plus the GROQ queries in ./queries.ts.
 * Hand-writing them let the schema and the types drift apart silently (a
 * `report.gallery` typed as required while the schema allowed it missing), and
 * `client.fetch()` on an unbranded query string returns `any`, so nothing
 * caught it. Regenerate instead of editing.
 *
 * `*DTO` = the internal, CMS-agnostic shapes the app renders, with assets
 * resolved to local paths. These stay hand-written on purpose: they are the
 * seam that lets the CMS be replaced without touching UI components.
 *
 * Raw -> DTO conversion (and every optional-field decision it implies) lives
 * in ./normalize.ts.
 */
import type {
  DeparturesQueryResult,
  LegalPagesQueryResult,
  OrganizersQueryResult,
  ReportsQueryResult,
  ReviewsQueryResult,
  SiteSettingsQueryResult,
  ToursQueryResult,
} from "./generated/sanity.types";

export type BookingStatus = "OPEN" | "CLOSED" | "CANCELLED";

/** Portable Text content. Treated opaquely and rendered via @portabletext/react. */
export type PortableTextBlocks = Record<string, unknown>[];

/**
 * Structural view of a Sanity image field. `asset` is optional in the generated
 * types for every image in the schema — an image object can exist with only its
 * `alt`/hotspot filled in, or with a since-deleted asset — and only some image
 * fields declare an `alt` at all. normalize.ts is what resolves both cases.
 */
export interface RawImageRef {
  _type: "image";
  asset?: { _ref: string; _type?: "reference" };
  alt?: string;
}

export type RawTour = ToursQueryResult[number];
export type RawDeparture = DeparturesQueryResult[number];
export type RawReport = ReportsQueryResult[number];
export type RawReview = ReviewsQueryResult[number];
export type RawOrganizer = OrganizersQueryResult[number];
export type RawLegalPage = LegalPagesQueryResult[number];
/** The query is `[0]`-indexed, so it is nullable; sync-sanity-content.ts fails the build on a missing singleton. */
export type RawSiteSettings = NonNullable<SiteSettingsQueryResult>;

export type RawDocument =
  | RawTour
  | RawDeparture
  | RawReport
  | RawReview
  | RawOrganizer
  | RawLegalPage
  | RawSiteSettings;

export interface RawContentSet {
  siteSettings: RawSiteSettings;
  tours: RawTour[];
  departures: RawDeparture[];
  reports: RawReport[];
  reviews: RawReview[];
  organizers: RawOrganizer[];
  legalPages: RawLegalPage[];
}

// ---------------------------------------------------------------------------
// Normalized DTOs (what the Next.js app actually renders)
// ---------------------------------------------------------------------------

export interface ImageVariants {
  thumbnail: string;
  card: string;
  gallery: string;
  hero: string;
  lightbox: string;
}

export interface ImageAsset {
  alt: string;
  width: number;
  height: number;
  variants: ImageVariants;
}

/**
 * Placeholder for an image that has been normalized but not yet downloaded /
 * resized to local variants. `sourceRef` is either `local:<fixture-filename>`
 * (dev/fixture mode) or a Sanity asset `_ref` (live mode). Produced by
 * scripts/sync-sanity-content.ts, consumed and resolved into `ImageAsset` by
 * scripts/materialize-assets.ts.
 */
export interface UnresolvedImageAsset {
  alt: string;
  sourceRef: string;
}

export interface SeoDTO<TImage = ImageAsset> {
  title?: string;
  description?: string;
  image?: TImage;
}

export interface TourDTO<TImage = ImageAsset> {
  id: string;
  slug: string;
  title: string;
  shortDescription: string;
  description?: PortableTextBlocks;
  coverImage: TImage;
  gallery: TImage[];
  isListed: boolean;
  sortOrder: number;
  seo?: SeoDTO<TImage>;
}

export interface DepartureDTO<TImage = ImageAsset> {
  id: string;
  tourId: string;
  startDate: string;
  endDate: string;
  bookingStatus: BookingStatus;
  price?: number;
  prepaymentAmount?: number;
  paymentQr?: TImage;
  organizerIds: string[];
  isListed: boolean;
  isDemo: boolean;
}

export interface ReportDTO<TImage = ImageAsset> {
  id: string;
  slug: string;
  title: string;
  tourId: string;
  departureId?: string;
  date?: string;
  coverImage: TImage;
  gallery: TImage[];
  description?: string;
  sortOrder: number;
}

export interface ReviewDTO<TImage = ImageAsset> {
  id: string;
  image: TImage;
  authorName?: string;
  tourId?: string;
  description?: string;
  sortOrder: number;
  isListed: boolean;
  isDemo: boolean;
}

export interface OrganizerDTO<TImage = ImageAsset> {
  id: string;
  name: string;
  phone: string;
  photo?: TImage;
  bio?: string;
  isListed: boolean;
  isDemo: boolean;
}

export interface LegalPageDTO {
  id: string;
  slug: string;
  title: string;
  content: PortableTextBlocks;
  updatedAt?: string;
}

export interface SiteSettingsDTO<TImage = ImageAsset> {
  siteName: string;
  siteUrl: string;
  timezone: string;
  logo?: TImage;
  favicon?: TImage;
  hero: { title: string; subtitle?: string; image: TImage };
  booking: {
    defaultQr?: TImage;
    defaultPrepaymentAmount?: number;
    defaultOrganizerId?: string;
    isDemo: boolean;
  };
  socials: { maxChannelUrl?: string };
  company: {
    legalName: string;
    inn: string;
    ogrn: string;
    phone: string;
    email?: string;
    isDemo: boolean;
  };
  seo: { title: string; description: string; ogImage?: TImage };
  launchReady: boolean;
}

export interface ContentSnapshot<TImage = ImageAsset> {
  generatedAt: string;
  source: "sanity" | "fixtures";
  siteSettings: SiteSettingsDTO<TImage>;
  tours: TourDTO<TImage>[];
  departures: DepartureDTO<TImage>[];
  reports: ReportDTO<TImage>[];
  reviews: ReviewDTO<TImage>[];
  organizers: OrganizerDTO<TImage>[];
  legalPages: LegalPageDTO[];
}

/** Shape written by sync-sanity-content.ts, before asset materialization. */
export type UnresolvedContentSnapshot = ContentSnapshot<UnresolvedImageAsset>;
