/** The static site's only booking action: leave for the isolated commerce service. */
export function commerceBookingUrl(commerceOrigin: string, departureId: string): string {
  const url = new URL("/book", commerceOrigin);
  url.searchParams.set("departure", departureId);
  return url.toString();
}
