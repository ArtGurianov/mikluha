"use client";

import "./globals.css";

/**
 * Under SSR every page starts with one Commerce read in the root layout
 * (lib/cms/content.ts). When it fails, Next answers 500 with its bare error
 * document and this paints the message in the browser: no dates, prices or
 * booking buttons, never a stale copy (ADR v2.3 §9 item 8). The static export
 * never reaches it.
 */
export default function GlobalError() {
  return (
    <html lang="ru">
      <body className="flex min-h-full flex-col font-sans">
        <main className="mx-auto flex min-h-[60vh] max-w-xl flex-col items-center justify-center gap-4 px-4 py-24 text-center">
          <h1 className="font-heading text-3xl font-semibold text-foreground sm:text-4xl">Сайт временно недоступен</h1>
          <p className="text-muted-foreground">
            Расписание и цены сейчас не загружаются. Обновите страницу через несколько минут.
          </p>
        </main>
      </body>
    </html>
  );
}
