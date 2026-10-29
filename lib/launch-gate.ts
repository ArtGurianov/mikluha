/**
 * The catalog half of the launch gate. The static build applies it to content/
 * (scripts/validate-content.ts); under SSR the catalog arrives from Commerce on
 * every request, so lib/cms/content.ts applies the same rules there whenever
 * the build is launch-ready. Site settings and legal pages stay gated at build
 * (`validate:content` in both pipelines).
 */
import type { ContentSnapshot } from "./cms/types";
import {
  demoContractFields,
  effectiveProduct,
  hasCompleteDepartureContract,
  hasCompleteTourContract,
} from "./contract-readiness";

type Catalog = Pick<ContentSnapshot, "tours" | "departures" | "reviews" | "organizers">;

/** Catalog documents still marked "Демо-данные". */
export function demoCatalogBlockers(content: Catalog): string[] {
  return [
    ...content.departures.filter((d) => d.isDemo).map((d) => `departure ${d.id} is still marked "Демо-данные"`),
    ...content.reviews.filter((rv) => rv.isDemo).map((rv) => `review ${rv.id} is still marked "Демо-данные"`),
    ...content.organizers.filter((o) => o.isDemo).map((o) => `organizer ${o.id} is still marked "Демо-данные"`),
  ];
}

/** OPEN departures whose contract a launch-ready site may not advertise. */
export function openDepartureContractBlockers(content: Catalog): string[] {
  const tourById = new Map(content.tours.map((tour) => [tour.id, tour]));
  return content.departures.filter((d) => d.bookingStatus === "OPEN").flatMap((departure) => {
    const product = effectiveProduct(tourById.get(departure.tourId)?.contract, departure.contract);
    return [
      ...(hasCompleteTourContract(product) ? [] : [`OPEN departure ${departure.id} has incomplete tour contract data`]),
      ...(hasCompleteDepartureContract(departure.contract)
        ? [] : [`OPEN departure ${departure.id} has incomplete departure contract data`]),
      ...[...demoContractFields(product, `departure ${departure.id}.product`),
        ...demoContractFields(departure.contract, `departure ${departure.id}.contract`)]
        .map((field) => `OPEN departure ${departure.id} uses explicit demo content in ${field}`),
    ];
  });
}

/** OPEN departures the booking flow cannot sell. */
export function openDepartureOfferBlockers(content: Catalog): string[] {
  return content.departures.filter((d) => d.bookingStatus === "OPEN").flatMap((d) => [
    ...(d.price === undefined ? [`OPEN departure ${d.id} has no price`] : []),
    ...(d.capacity === undefined ? [`OPEN departure ${d.id} has no capacity`] : []),
  ]);
}

/** Throws, naming every blocker, when a launch-ready site would render this catalog. */
export function assertCatalogLaunchReady(content: Catalog): void {
  const blockers = [...demoCatalogBlockers(content), ...openDepartureContractBlockers(content),
    ...openDepartureOfferBlockers(content)];
  if (blockers.length > 0) throw new Error(`CATALOG_NOT_LAUNCH_READY: ${blockers.join("; ")}`);
}
