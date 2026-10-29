"use client";

import "./globals.css";

/**
 * The last resort when the root layout itself fails. The layout never reads
 * Commerce (a catalog outage is app/error.tsx), so this is a broken release,
 * not an outage: no dates, prices or booking buttons, never a stale copy.
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
