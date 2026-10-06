// Production backstop for the CMS contract fields. Keep these completeness rules aligned with
// commerce/src/catalog.ts: the site must not advertise an OPEN departure that commerce refuses.

const text = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : null;
const lines = (value: unknown): string[] =>
  (text(value) ?? "").split("\n").map((line) => line.trim()).filter((line) => line !== "");
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

export function hasCompleteTourContract(value: unknown): boolean {
  const contract = record(value);
  const program = Array.isArray(contract.program)
    ? contract.program.map((day) => ({
        title: text(record(day).title),
        items: lines(record(day).items),
      }))
    : [];

  return text(contract.destination) !== null
    && text(contract.route) !== null
    && text(contract.risks) !== null
    && lines(contract.included).length > 0
    && program.length > 0
    && program.every((day) => day.title !== null && day.items.length > 0);
}

/** A departure's product is a whole replacement, even when incomplete/null. */
export function effectiveProduct(tour: unknown, departure: unknown): unknown {
  const contract = record(departure);
  return Object.hasOwn(contract, 'product') ? contract.product : tour;
}

export function hasQualifiedRefundPolicy(value: unknown): boolean {
  return value === 'FULL_ONLY';
}

export function hasCompleteDepartureContract(value: unknown): boolean {
  const contract = record(value);
  const accommodation = record(contract.accommodation);
  const carrier = record(contract.carrier);
  const required = [
    contract.departurePoint,
    contract.returnPoint,
    accommodation.name,
    accommodation.address,
    accommodation.roomType,
    accommodation.meals,
    accommodation.legalEntity,
    carrier.legalName,
    carrier.route,
    carrier.baggage,
    carrier.boarding,
  ];
  const time = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
  const nights = accommodation.nights;
  const services = Array.isArray(contract.services) ? contract.services : [];

  return required.every((field) => text(field) !== null)
    && typeof contract.departureTime === 'string' && time.test(contract.departureTime)
    && typeof contract.returnTime === 'string' && time.test(contract.returnTime)
    && typeof nights === "number"
    && Number.isSafeInteger(nights)
    && nights >= 0
    && services.every((service) => {
      const item = record(service);
      return text(item.name) !== null && text(item.supplier) !== null && typeof item.included === 'boolean';
    });
}

const DEMO_MARKER = /(^|[^\p{L}])демо(?=$|[^\p{L}])/iu;

/** Paths of contract strings explicitly marked as demo content. */
export function demoContractFields(value: unknown, path = "contract"): string[] {
  if (typeof value === "string") return DEMO_MARKER.test(value) ? [path] : [];
  if (Array.isArray(value)) return value.flatMap((item, index) => demoContractFields(item, `${path}[${index}]`));
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, item]) => demoContractFields(item, `${path}.${key}`));
}
