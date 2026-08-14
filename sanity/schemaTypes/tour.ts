import { defineField, defineType } from "sanity";

export const tour = defineType({
  name: "tour",
  title: "Направление",
  type: "document",
  groups: [
    { name: "content", title: "Контент", default: true },
    { name: "media", title: "Фото" },
    { name: "seo", title: "SEO" },
    { name: "system", title: "Технические поля" },
  ],
  fields: [
    defineField({
      name: "title",
      title: "Название",
      type: "string",
      description: "Например: «Горный Алтай»",
      group: "content",
      validation: (rule) => rule.required(),
    }),
    defineField({
      name: "slug",
      title: "Адрес страницы (slug)",
      type: "slug",
      group: "system",
      description: "Генерируется автоматически из названия. После публикации менять не рекомендуется.",
      options: { source: "title", maxLength: 96 },
      validation: (rule) => rule.required(),
    }),
    defineField({
      name: "shortDescription",
      title: "Краткое описание",
      type: "text",
      rows: 2,
      description: "Показывается на карточке направления на главной странице.",
      group: "content",
      validation: (rule) => rule.required().max(220),
    }),
    defineField({
      name: "description",
      title: "Полное описание",
      type: "array",
      of: [{ type: "block" }],
      group: "content",
    }),
    defineField({
      name: "coverImage",
      title: "Обложка",
      type: "image",
      group: "media",
      options: { hotspot: true },
      fields: [
        defineField({
          name: "alt",
          title: "Альтернативный текст (alt)",
          type: "string",
          validation: (rule) => rule.required(),
        }),
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
            defineField({
              name: "alt",
              title: "Альтернативный текст (alt)",
              type: "string",
              validation: (rule) => rule.required(),
            }),
          ],
        },
      ],
    }),
    defineField({
      name: "isListed",
      title: "Показывать на сайте",
      type: "boolean",
      group: "content",
      initialValue: true,
      description: "Выключите, чтобы временно скрыть направление из публичного каталога.",
    }),
    defineField({
      name: "sortOrder",
      title: "Порядок сортировки",
      type: "number",
      group: "system",
      description: "Чем меньше число, тем выше направление в списке.",
      initialValue: 0,
    }),
    defineField({
      name: "seo",
      title: "SEO",
      type: "object",
      group: "seo",
      fields: [
        defineField({ name: "title", title: "SEO-заголовок", type: "string" }),
        defineField({ name: "description", title: "SEO-описание", type: "text", rows: 2 }),
        defineField({
          name: "image",
          title: "OG-изображение",
          type: "image",
          options: { hotspot: true },
        }),
      ],
    }),
  ],
  preview: {
    select: { title: "title", media: "coverImage", isListed: "isListed" },
    prepare({ title, media, isListed }) {
      return {
        title,
        subtitle: isListed ? "Показан на сайте" : "Скрыт",
        media,
      };
    },
  },
});
