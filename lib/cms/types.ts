/**
 * The CMS integration boundary.
 *
 * `Raw*` = the shape a Sveltia CMS content file actually has on disk once
 * parsed from YAML by scripts/sync-content.ts. These are hand-written and kept
 * in sync by hand with public/admin/config.yml's field list — there is no
 * schema-extraction/typegen step for a Git-based CMS, so a field renamed in
 * one place and not the other only shows up as a normalize.ts crash naming the
 * offending document, same as it always did for a genuinely missing field.
 *
 * `*DTO` = the internal, CMS-agnostic shapes the app renders, with assets
 * resolved to local paths. These stay hand-written on purpose: they are the
 * seam that lets the CMS be replaced without touching UI components.
 *
 * Raw -> DTO conversion (and every optional-field decision it implies) lives
 * in ./normalize.ts.
 */

export type BookingStatus = "OPEN" | "CLOSED" | "CANCELLED";

/**
 * An image field as Sveltia's `image` + `alt` object pair writes it: `image`
 * is either a real asset URL (the cloud.ru object the media library uploaded
 * to) or, for the seed/demo content in content/, a `local:<filename>` ref
 * resolved from content/assets/ by scripts/materialize-assets.ts. Optional
 * fields can exist with only `alt` filled in (or nothing at all), same as
 * a Sveltia image widget could — normalize.ts is what resolves that.
 */
export interface RawImageRef {
  image?: string;
  alt?: string;
}

export interface RawTour {
  title: string;
  /** Also the user-facing route slug (`/tours/<slug>/`), explicit and ASCII-validated — see lib/legal.ts's SLUG_RE. */
  slug: string;
  shortDescription: string;
  description?: string;
  coverImage: RawImageRef;
  gallery?: RawImageRef[];
  isListed?: boolean;
  sortOrder?: number;
  seo?: { title?: string; description?: string; image?: RawImageRef };
  /** Filename (without extension) — the collection's `slug` template output (`{{fields.slug}}`, so this always equals `slug` above). Injected by sync-content.ts, not a real YAML field. */
  _slug: string;
}

export interface RawDeparture {
  tour: string;
  startDate: string;
  endDate: string;
  bookingStatus: BookingStatus;
  price?: number;
  prepaymentAmount?: number;
  paymentQr?: RawImageRef;
  organizers?: string[];
  isListed?: boolean;
  isDemo?: boolean;
  _slug: string;
}

export interface RawReport {
  title: string;
  /** Also the user-facing route slug (`/reports/<slug>/`), explicit and ASCII-validated — see lib/legal.ts's SLUG_RE. */
  slug: string;
  tour: string;
  departure?: string;
  date?: string;
  coverImage: RawImageRef;
  gallery?: RawImageRef[];
  description?: string;
  sortOrder?: number;
  _slug: string;
}

export interface RawReview {
  image: RawImageRef;
  authorName: string;
  tour?: string;
  description?: string;
  sortOrder?: number;
  isListed?: boolean;
  isDemo?: boolean;
  _slug: string;
}

export interface RawOrganizer {
  name: string;
  phone: string;
  photo?: RawImageRef;
  bio?: string;
  isListed?: boolean;
  isDemo?: boolean;
  _slug: string;
}

export interface RawLegalPage {
  title: string;
  /** Also the user-facing route slug, unlike other collections' `_slug` — see lib/legal.ts. */
  slug: string;
  content: string;
  updatedAt?: string;
  _slug: string;
}

export interface RawSiteSettings {
  siteName: string;
  siteUrl: string;
  timezone: string;
  logo?: RawImageRef;
  favicon?: RawImageRef;
  hero?: { title: string; subtitle?: string; image: RawImageRef };
  booking?: {
    defaultQr?: RawImageRef;
    defaultPrepaymentAmount?: number;
    defaultOrganizer?: string;
    isDemo?: boolean;
  };
  socials?: { maxChannelUrl?: string };
  company?: {
    legalName: string;
    inn: string;
    ogrn: string;
    phone: string;
    email?: string;
    isDemo?: boolean;
  };
  seo?: { title: string; description: string; ogImage?: RawImageRef };
  launchReady?: boolean;
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
 * resized to local variants. `sourceRef` is either `local:<filename>`
 * (seed/demo assets in content/assets/) or a real asset URL (cloud.ru, once
 * uploaded through the CMS). Produced by scripts/sync-content.ts, consumed
 * and resolved into `ImageAsset` by scripts/materialize-assets.ts.
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
  /** Markdown. */
  description?: string;
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
  authorName: string;
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
  /** Markdown. */
  content: string;
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
  source: "git";
  siteSettings: SiteSettingsDTO<TImage>;
  tours: TourDTO<TImage>[];
  departures: DepartureDTO<TImage>[];
  reports: ReportDTO<TImage>[];
  reviews: ReviewDTO<TImage>[];
  organizers: OrganizerDTO<TImage>[];
  legalPages: LegalPageDTO[];
}

/** Shape written by sync-content.ts, before asset materialization. */
export type UnresolvedContentSnapshot = ContentSnapshot<UnresolvedImageAsset>;
