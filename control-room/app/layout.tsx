import type { Metadata } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: "Миклуха · Control Room",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ru">
      <body>
        <header className="bar">
          <span className="brand">Миклуха</span>
          <span className="muted">Control Room</span>
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
