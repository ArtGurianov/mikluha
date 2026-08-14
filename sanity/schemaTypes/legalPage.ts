import { defineField, defineType } from "sanity";

// Any slug is allowed — app/[legalSlug]/ generates a static route per document,
// so the organizer can publish an offer, refund policy or traveller's memo
// without a code release. Only two things are rejected: a slug the router
// cannot serve, and one that would shadow an existing route or build artifact.
// Kept in sync with lib/legal.ts, which is where the build-time check reads
// them from (the Studio bundle cannot import from outside sanity/).
const RESERVED_SLUGS = [
  "tours",
  "reports",
  "_next",
  "generated",
  "api",
  "index",
  "404",
  "robots.txt",
  "sitemap.xml",
  "icon.png",
  "apple-icon.png",
];
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const legalPage = defineType({
  name: "legalPage",
  title: "Правовая страница",
  type: "document",
  fields: [
    defineField({
      name: "title",
      title: "Заголовок",
      type: "string",
      validation: (rule) => rule.required(),
    }),
    defineField({
      name: "slug",
      title: "Адрес страницы (slug)",
      type: "slug",
      description:
        "Адрес страницы на сайте: например booking-terms → /booking-terms/. " +
        "Только латиница в нижнем регистре, цифры и дефис. После публикации менять не рекомендуется — " +
        "старый адрес перестанет открываться.",
      options: { source: "title", maxLength: 96 },
      validation: (rule) =>
        rule
          .required()
          .custom((value) => {
            const slug = value?.current;
            if (!slug) return true;
            if (!SLUG_RE.test(slug)) {
              return "Только латиница в нижнем регистре, цифры и дефис — например public-offer";
            }
            if (RESERVED_SLUGS.includes(slug)) {
              return `Адрес «${slug}» занят разделом сайта — выберите другой`;
            }
            return true;
          }),
    }),
    defineField({
      name: "content",
      title: "Текст страницы",
      type: "array",
      of: [{ type: "block" }],
      validation: (rule) => rule.required(),
    }),
    defineField({
      name: "updatedAt",
      title: "Дата обновления текста",
      type: "date",
      options: { dateFormat: "DD.MM.YYYY" },
    }),
  ],
  preview: {
    select: { title: "title", slug: "slug.current" },
    prepare({ title, slug }) {
      return { title, subtitle: slug ? `/${slug}` : undefined };
    },
  },
});
