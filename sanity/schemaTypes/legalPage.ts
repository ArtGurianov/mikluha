import { defineField, defineType } from "sanity";

// The Next.js app currently only has routes for these two pages
// (app/booking-terms/, app/privacy-policy/) — see PRD §21.1. Any other slug
// would publish successfully in Sanity but 404 on the site and fail the
// production build's route-completeness check, so it's constrained here
// instead of surfacing as a confusing build failure later.
const ALLOWED_SLUGS = ["booking-terms", "privacy-policy"] as const;

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
      description: "На сайте сейчас существуют только эти два маршрута — другой адрес не будет работать.",
      options: { source: "title", maxLength: 96 },
      validation: (rule) =>
        rule
          .required()
          .custom((value) =>
            value?.current && !(ALLOWED_SLUGS as readonly string[]).includes(value.current)
              ? `Адрес должен быть одним из: ${ALLOWED_SLUGS.join(", ")}`
              : true,
          ),
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
