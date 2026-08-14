import { defineField, defineType } from "sanity";

export const review = defineType({
  name: "review",
  title: "Отзыв",
  type: "document",
  fields: [
    defineField({
      name: "image",
      title: "Изображение отзыва",
      type: "image",
      description: "Обычно — скриншот переписки с клиентом.",
      fields: [
        defineField({ name: "alt", title: "Alt", type: "string", validation: (rule) => rule.required() }),
      ],
      validation: (rule) => rule.required(),
    }),
    defineField({
      name: "authorName",
      title: "Имя автора",
      type: "string",
      description: "Опционально.",
    }),
    defineField({
      name: "tour",
      title: "Связанное направление",
      type: "reference",
      to: [{ type: "tour" }],
      description: "Опционально.",
    }),
    defineField({
      name: "description",
      title: "Комментарий",
      type: "text",
      rows: 2,
      description: "Опционально, если нужно продублировать текстом.",
    }),
    defineField({
      name: "sortOrder",
      title: "Порядок сортировки",
      type: "number",
      initialValue: 0,
    }),
    defineField({
      name: "isListed",
      title: "Показывать на сайте",
      type: "boolean",
      initialValue: true,
    }),
    defineField({
      name: "isDemo",
      title: "Демо-данные (тест)",
      type: "boolean",
      initialValue: false,
      description: "Включите для тестовых отзывов. Блокирует публичный запуск сайта, пока не будет заменено.",
    }),
  ],
  preview: {
    select: { authorName: "authorName", tourTitle: "tour.title", media: "image" },
    prepare({ authorName, tourTitle, media }) {
      return {
        title: authorName || "Без имени",
        subtitle: tourTitle,
        media,
      };
    },
  },
});
