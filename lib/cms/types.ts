/**
 * Shapes shared between the build-time Sanity adapter (scripts/sync-sanity-content.mjs)
 * and the Next.js app. Raw* types mirror what GROQ returns (and what the local
 * fixtures in lib/cms/fixtures/*.json are written to match); normalized DTOs are
 * what pages/components actually consume, with assets resolved to local paths.
 */

export type BookingStatus = "OPEN" | "CLOSED" | "CANCELLED";

export interface SanitySlug {
  current: string;
}

export interface SanityReference {
  _ref: string;
  _type: "reference";
}

/** Portable Text content. Treated opaquely and rendered via @portabletext/react. */
export type PortableTextBlocks = Record<string, unknown>[];

export interface RawImageRef {
  _type: "image";
  asset: { _ref: string; _type: "reference" };
  alt?: string;
}

export interface RawSeo {
  title?: string;
  description?: string;
  image?: RawImageRef;
}

export interface RawTour {
  _id: string;
  _type: "tour";
  title: string;
  slug: SanitySlug;
  shortDescription: string;
  description?: PortableTextBlocks;
  coverImage: RawImageRef;
  gallery?: RawImageRef[];
  isListed: boolean;
  sortOrder?: number;
  seo?: RawSeo;
}

export interface RawDeparture {
  _id: string;
  _type: "departure";
  tour: SanityReference;
  startDate: string;
  endDate: string;
  bookingStatus: BookingStatus;
  price?: number;
  prepaymentAmount?: number;
  paymentQr?: RawImageRef;
  organizers?: SanityReference[];
  isListed: boolean;
  isDemo: boolean;
}

export interface RawReport {
  _id: string;
  _type: "report";
  title: string;
  slug: SanitySlug;
  tour: SanityReference;
  departure?: SanityReference;
  date?: string;
  coverImage: RawImageRef;
  /** Sanity's `min(1)` validator is a Studio-only affordance, not a data-layer guarantee — treat as optional. */
  gallery?: RawImageRef[];
  description?: string;
  sortOrder?: number;
}

export interface RawReview {
  _id: string;
  _type: "review";
  image: RawImageRef;
  authorName?: string;
  tour?: SanityReference;
  description?: string;
  sortOrder?: number;
  isListed: boolean;
  isDemo: boolean;
}

export interface RawOrganizer {
  _id: string;
  _type: "organizer";
  name: string;
  phone: string;
  photo?: RawImageRef;
  bio?: string;
  isListed: boolean;
  isDemo: boolean;
}

export interface RawLegalPage {
  _id: string;
  _type: "legalPage";
  title: string;
  slug: SanitySlug;
  content: PortableTextBlocks;
  updatedAt?: string;
}

export interface RawSiteSettings {
  _id: "siteSettings";
  _type: "siteSettings";
  siteName: string;
  siteUrl: string;
  timezone: string;
  logo?: RawImageRef;
  favicon?: RawImageRef;
  hero: { title: string; subtitle?: string; image: RawImageRef };
  booking: {
    defaultQr?: RawImageRef;
    defaultPrepaymentAmount?: number;
    defaultOrganizer?: SanityReference;
    isDemo: boolean;
  };
  socials?: { maxChannelUrl?: string };
  company: {
    legalName: string;
    inn: string;
    ogrn: string;
    phone: string;
    email?: string;
    isDemo: boolean;
  };
  seo: { title: string; description: string; ogImage?: RawImageRef };
  launchReady: boolean;
}

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
