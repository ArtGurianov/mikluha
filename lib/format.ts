const rubFormatter = new Intl.NumberFormat("ru-RU", {
  style: "currency",
  currency: "RUB",
  maximumFractionDigits: 0,
});
const rubKopecksFormatter = new Intl.NumberFormat("ru-RU", {
  style: "currency",
  currency: "RUB",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** Whole rubles as before; a Commerce price with kopecks (SSR) shows them, never rounded away. */
export function formatRub(amount: number): string {
  return (Number.isInteger(amount) ? rubFormatter : rubKopecksFormatter).format(amount);
}

export function telHref(phone: string): string {
  return `tel:${phone.replace(/[^\d+]/g, "")}`;
}
