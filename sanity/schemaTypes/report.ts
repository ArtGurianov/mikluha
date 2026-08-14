import { defineField, defineType } from "sanity";

export const report = defineType({
  name: "report",
  title: "Отчёт о поездке",
  type: "document",
  groups: [
    { name: "content", title: "Контент", default: true },
    { name: "media", title: "Фото" },
    { name: "system", title: "Технические поля" },
  ],
  fields: [
    defineField({
      name: "title",
      title: "Название",
      type: "string",
      group: "content",
      validation: (rule) => rule.required(),
    }),
    defineField({
      name: "slug",
      title: "Адрес страницы (slug)",
      type: "slug",
      group: "system",
      options: { source: "title", maxLength: 96 },
      validation: (rule) => rule.required(),
    }),
    defineField({
      name: "tour",
      title: "Направление",
      type: "reference",
      to: [{ type: "tour" }],
      group: "content",
      validation: (rule) => rule.required(),
    }),
    defineField({
      name: "departure",
      title: "Связанный выезд",
      type: "reference",
      to: [{ type: "departure" }],
      group: "content",
      description: "Если указан, дата отчёта берётся из выезда автоматически.",
    }),
    defineField({
      name: "date",
      title: "Дата поездки",
      type: "date",
      group: "content",
      options: { dateFormat: "DD.MM.YYYY" },
      description: "Заполняйте только если нет связанного выезда.",
      hidden: ({ document }) => Boolean(document?.departure),
    }),
    defineField({
      name: "coverImage",
      title: "Обложка",
      type: "image",
      group: "media",
      options: { hotspot: true },
      fields: [
        defineField({ name: "alt", title: "Alt", type: "string", validation: (rule) => rule.required() }),
      ],
      validation: (rule) => rule.required(),
    }),
    defineField({
      name: "gallery",
      title: "Галерея фото",
      type: "array",
      group: "media",
      of: [
        {
          type: "image",
          options: { hotspot: true },
          fields: [
            defineField({ name: "alt", title: "Alt", type: "string", validation: (rule) => rule.required() }),
          ],
        },
      ],
      validation: (rule) => rule.min(1),
    }),
    defineField({
      name: "description",
      title: "Описание",
      type: "text",
      rows: 4,
      group: "content",
    }),
    defineField({
      name: "sortOrder",
      title: "Порядок сортировки",
      type: "number",
      group: "system",
      initialValue: 0,
    }),
  ],
  preview: {
    select: { title: "title", tourTitle: "tour.title", media: "coverImage" },
    prepare({ title, tourTitle, media }) {
      return { title, subtitle: tourTitle, media };
    },
  },
});
