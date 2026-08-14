import { BookingButton } from "@/components/booking/booking-button";

export function CtaSection() {
  return (
    <section className="bg-primary text-primary-foreground">
      <div className="mx-auto flex max-w-6xl flex-col items-center gap-4 px-4 py-16 text-center sm:px-6">
        <h2 className="font-heading text-2xl font-semibold sm:text-3xl">Готовы в горы?</h2>
        <p className="max-w-xl text-primary-foreground/85">
          Забронируйте место предоплатой по QR-коду — место закрепляется за вами после подтверждения организатором.
        </p>
        <BookingButton size="lg" variant="secondary" className="mt-2 text-base" />
      </div>
    </section>
  );
}
