/**
 * Raw projection/settings inputs and the normalized DTOs rendered by the site.
 * Conversion and optional-field decisions live in normalize.ts.
 */
export type BookingStatus = "OPEN" | "CLOSED" | "CANCELLED";

/**
 * An image reference with its alternative text. `image`
 * is either a direct Object Storage URL or a tracked `/media/demo/*.webp`
 * fallback. No build step downloads or transforms it.
 */
export interface RawImageRef {
  image?: string | null;
  alt?: string | null;
}

export interface RawTourContract {
  destination?: string | null;
  route?: string | null;
  program?: { title?: string | null; items?: string | null }[] | null;
  included?: string | null;
  excluded?: string | null;
  insurance?: string | null;
  risks?: string | null;
}

export interface RawDepartureContract {
  /** Complete per-departure product conditions; replace tour defaults, never partially merge. */
  product?: RawTourContract | null;
  departureTime?: string | null;
  returnTime?: string | null;
  departurePoint?: string | null;
  returnPoint?: string | null;
  accommodation?: {
    name?: string | null;
    address?: string | null;
    category?: string | null;
    registryNumber?: string | null;
    roomType?: string | null;
    nights?: number | null;
    meals?: string | null;
    legalEntity?: string | null;
  } | null;
  carrier?: {
    legalName?: string | null;
    route?: string | null;
    vehicle?: string | null;
    baggage?: string | null;
    boarding?: string | null;
  } | null;
  services?: { name?: string | null; supplier?: string | null; included?: boolean | null; note?: string | null }[] | null;
}

export interface RawTour {
  title: string | null;
  /** Also the user-facing route slug (`/tours/<slug>/`), explicit and ASCII-validated — see lib/legal.ts's SLUG_RE. */
  slug: string | null;
  /** Visible page H1 — the search-intent heading ("Автобусный тур на … из Кемерово"); `title` stays the short name used on cards, chips and breadcrumbs. */
  heading?: string | null;
  shortDescription: string | null;
  description?: string | null;
  coverImage: RawImageRef | null;
  gallery?: RawImageRef[] | null;
  contract?: RawTourContract | null;
  isListed?: boolean | null;
  sortOrder?: number | null;
  seo?: { title?: string | null; description?: string | null; image?: RawImageRef | null } | null;
  /** YYYY-MM-DD of the last significant edit — feeds sitemap `lastmod`. */
  updatedAt?: string | null;
  /** Filename (without extension) — the collection's `slug` template output (`{{fields.slug}}`, so this always equals `slug` above). Injected by sync-content.ts, not a real YAML field. */
  _slug: string;
}

export interface RawDeparture {
  tour: string | null;
  startDate: string | null;
  endDate: string | null;
  bookingStatus: BookingStatus | null;
  price?: number | null;
  capacity?: number | null;
  contract?: RawDepartureContract | null;
  organizers?: string[] | null;
  isListed?: boolean | null;
  isDemo?: boolean | null;
  updatedAt?: string | null;
  _slug: string;
}

export interface RawReport {
  title: string | null;
  /** Also the user-facing route slug (`/reports/<slug>/`), explicit and ASCII-validated — see lib/legal.ts's SLUG_RE. */
  slug: string | null;
  tour: string | null;
  departure?: string | null;
  date?: string | null;
  coverImage: RawImageRef | null;
  gallery?: RawImageRef[] | null;
  description?: string | null;
  sortOrder?: number | null;
  /** Keep the page on the site but out of search results and the sitemap (a thin report). */
  noindex?: boolean | null;
  updatedAt?: string | null;
  _slug: string;
}

export interface RawReview {
  image: RawImageRef | null;
  authorName: string | null;
  tour?: string | null;
  description?: string | null;
  sortOrder?: number | null;
  isListed?: boolean | null;
  isDemo?: boolean | null;
  _slug: string;
}

export interface RawOrganizer {
  name: string | null;
  phone: string | null;
  photo?: RawImageRef | null;
  bio?: string | null;
  isListed?: boolean | null;
  isDemo?: boolean | null;
  _slug: string;
}

export interface RawLegalPage {
  refundPolicy?: 'FULL_ONLY' | 'DOCUMENTED_EXPENSES' | null;
  title: string | null;
  /** Also the user-facing route slug, unlike other collections' `_slug` — see lib/legal.ts. */
  slug: string | null;
  content: string | null;
  updatedAt?: string | null;
  _slug: string;
}

export interface RawSiteSettings {
  siteName: string | null;
  siteUrl: string | null;
  commerceOrigin: string | null;
  timezone: string | null;
  logo?: RawImageRef | null;
  hero?: {
    title: string | null;
    subtitle?: string | null;
    image: RawImageRef | null;
    video: { file?: string | null } | null;
  } | null;
  socials?: { maxChannelUrl?: string | null } | null;
  company?: {
    legalName: string | null;
    inn: string | null;
    ogrn: string | null;
    phone: string | null;
    email?: string | null;
    city?: string | null;
    isDemo?: boolean | null;
  } | null;
  seo?: { title: string | null; description: string | null; ogImage?: RawImageRef | null } | null;
  launchReady?: boolean | null;
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

export interface ImageAsset {
  alt: string;
  src: string;
}

export interface VideoAsset {
  src: string;
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
  heading?: string;
  shortDescription: string;
  /** Markdown. */
  description?: string;
  coverImage: TImage;
  gallery: TImage[];
  contract?: RawTourContract;
  isListed: boolean;
  sortOrder: number;
  seo?: SeoDTO<TImage>;
  updatedAt?: string;
}

export interface DepartureDTO {
  id: string;
  tourId: string;
  startDate: string;
  endDate: string;
  bookingStatus: BookingStatus;
  price?: number;
  /** Seats sold online; mikluha-commerce counts the taken ones (docs/DECISIONS.md #9). */
  capacity?: number;
  contract?: RawDepartureContract;
  organizerIds: string[];
  isListed: boolean;
  isDemo: boolean;
  updatedAt?: string;
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
  noindex: boolean;
  updatedAt?: string;
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
  publication?: { version: number; documentSha256: string; textSha256: string };
  refundPolicy?: 'FULL_ONLY' | 'DOCUMENTED_EXPENSES' | null;
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
  commerceOrigin: string;
  timezone: string;
  logo?: TImage;
  hero: { title: string; subtitle?: string; image: TImage; video: VideoAsset };
  socials: { maxChannelUrl?: string };
  company: {
    legalName: string;
    inn: string;
    ogrn: string;
    phone: string;
    email?: string;
    city?: string;
    isDemo: boolean;
  };
  seo: { title: string; description: string; ogImage?: TImage };
  launchReady: boolean;
}

/** `git`: build input. `commerce`: request-time catalog and legal authority; settings from Git. */
export type ContentSource = "git" | "commerce";

export interface ContentSnapshot<TImage = ImageAsset> {
  generatedAt: string;
  source: ContentSource;
  siteSettings: SiteSettingsDTO<TImage>;
  tours: TourDTO<TImage>[];
  departures: DepartureDTO[];
  reports: ReportDTO<TImage>[];
  reviews: ReviewDTO<TImage>[];
  organizers: OrganizerDTO<TImage>[];
  legalPages: LegalPageDTO[];
}
