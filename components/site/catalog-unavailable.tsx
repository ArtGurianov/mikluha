import Link from "next/link";

/** Server-rendered outage state: readable before hydration and with JavaScript disabled. */
export function CatalogUnavailable() {
  return (
    <section className="mx-auto max-w-xl space-y-4 px-4 py-24 text-center" role="status">
      <h1 className="font-heading text-3xl font-semibold">Расписание временно недоступно</h1>
      <p>Даты и цены сейчас не загружаются. Попробуйте через несколько минут.</p>
      <p><a href="">Обновить страницу</a></p>
      <p><Link href="/oferta/" prefetch={false}>Публичная оферта</Link> · <Link href="/#contacts" prefetch={false}>Контакты организатора</Link></p>
    </section>
  );
}
