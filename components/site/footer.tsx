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
      <div className="mx-auto grid max-w-6xl gap-8 px-4 py-12 sm:px-6 md:grid-cols-2">
        <div className="space-y-2">
          <p className="text-sm text-secondary-foreground/80">{company.legalName}</p>
          <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-1 pt-2 text-sm text-secondary-foreground/80">
            <dt>ИНН:</dt>
            <dd>{company.inn}</dd>
            <dt>ОГРН/ОГРНИП:</dt>
            <dd>{company.ogrn}</dd>
            <dt>Телефон:</dt>
            <dd>
              <a href={telHref(company.phone)} className="underline-offset-4 hover:underline">
                {company.phone}
              </a>
            </dd>
            {company.email && (
              <>
                <dt>Email:</dt>
                <dd>
                  <a href={`mailto:${company.email}`} className="underline-offset-4 hover:underline">
                    {company.email}
                  </a>
                </dd>
              </>
            )}
          </dl>
        </div>

        <div className="flex flex-col gap-2 text-sm md:items-end">
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
        </div>
      </div>
      <div className="border-t border-secondary-foreground/15 px-4 py-4 text-center text-xs text-secondary-foreground/70 sm:px-6">
        © {year} {siteSettings.siteName}
      </div>
    </footer>
  );
}
