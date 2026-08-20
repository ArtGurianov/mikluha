import Link from "next/link";

import { telHref } from "@/lib/format";
import type { LegalPageDTO, SiteSettingsDTO } from "@/lib/cms/types";

export function Footer({
  siteSettings,
  legalPages,
}: {
  siteSettings: SiteSettingsDTO;
  legalPages: LegalPageDTO[];
}) {
  const { company, socials } = siteSettings;
  const year = new Date().getFullYear();

  return (
    <footer id="contacts" className="border-t border-border bg-secondary text-secondary-foreground">
      <div className="mx-auto flex max-w-6xl flex-col gap-4 px-4 py-6 sm:px-6 md:flex-row md:items-end md:justify-between">
        <div className="min-w-0 space-y-2">
          <p className="text-sm text-secondary-foreground/90">
            {company.legalName}
            <span className="ml-3 text-xs text-secondary-foreground/65">
              © {year} {siteSettings.siteName}
            </span>
          </p>
          <dl className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-secondary-foreground/75 sm:text-sm">
            <div className="flex gap-1">
              <dt>ИНН:</dt>
              <dd>{company.inn}</dd>
            </div>
            <div className="flex gap-1">
              <dt>ОГРН:</dt>
              <dd>{company.ogrn}</dd>
            </div>
            <div className="flex gap-1">
              <dt>Телефон:</dt>
              <dd>
                <a href={telHref(company.phone)} className="underline-offset-4 hover:underline">
                  {company.phone}
                </a>
              </dd>
            </div>
            {company.email && (
              <div className="flex min-w-0 gap-1">
                <dt>Email:</dt>
                <dd className="min-w-0 break-all">
                  <a href={`mailto:${company.email}`} className="underline-offset-4 hover:underline">
                    {company.email}
                  </a>
                </dd>
              </div>
            )}
          </dl>
        </div>

        <nav aria-label="Дополнительные ссылки" className="flex flex-wrap gap-x-4 gap-y-1.5 text-sm md:justify-end">
          {socials.maxChannelUrl && (
            <a
              href={socials.maxChannelUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="text-secondary-foreground/90 underline-offset-4 hover:underline"
            >
              Канал в MAX
            </a>
          )}
          {/* Every legal page the CMS has, titled by the document — so a new
              one (оферта, возврат, памятка) appears here on publish, with no
              code change and no hardcoded label to fall out of sync. */}
          {legalPages.map((page) => (
            <Link
              key={page.id}
              href={`/${page.slug}/`}
              className="text-secondary-foreground/90 underline-offset-4 hover:underline"
            >
              {page.title}
            </Link>
          ))}
        </nav>
      </div>
    </footer>
  );
}
