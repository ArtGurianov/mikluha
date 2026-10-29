"use client";

import Link from "next/link";

import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Under SSR a catalog page starts with one Commerce read (lib/cms/content.ts).
 * When it fails, this replaces the page inside the layout, which never reads
 * Commerce: header, footer and the legal pages stay reachable, and no date,
 * price or booking button is shown — never a stale copy (ADR v2.3 §9 item 8).
 * `retry` fetches and renders the page again once Commerce is back. The static
 * export never reaches it.
 */
export default function CatalogError({ retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <div className="mx-auto flex min-h-[60vh] max-w-xl flex-col items-center justify-center gap-4 px-4 py-24 text-center">
      <h1 className="font-heading text-3xl font-semibold text-foreground sm:text-4xl">Расписание временно недоступно</h1>
      <p className="text-muted-foreground">
        Даты и цены сейчас не загружаются. Попробуйте через несколько минут — документы и контакты организатора
        доступны как обычно.
      </p>
      <div className="mt-2 flex flex-wrap justify-center gap-3">
        <button type="button" onClick={() => retry()} className={cn(buttonVariants({ variant: "default" }))}>
          Обновить
        </button>
        <Link href="/oferta/" className={cn(buttonVariants({ variant: "outline" }))}>
          Публичная оферта
        </Link>
      </div>
    </div>
  );
}
