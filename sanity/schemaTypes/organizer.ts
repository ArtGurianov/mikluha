import { defineField, defineType } from "sanity";

export const organizer = defineType({
  name: "organizer",
  title: "Организатор",
  type: "document",
  fields: [
    defineField({
      name: "name",
      title: "Имя",
      type: "string",
      validation: (rule) => rule.required(),
    }),
    defineField({
      name: "phone",
      title: "Телефон",
      type: "string",
      description: "В формате +7XXXXXXXXXX. Используется в Booking Modal и как ссылка tel:.",
      validation: (rule) =>
        rule
          .required()
          .regex(/^\+7\d{10}$/, {
            name: "phone",
            invert: false,
          })
          .error("Введите телефон в формате +7XXXXXXXXXX"),
    }),
    defineField({
      name: "photo",
      title: "Фотография",
      type: "image",
      options: { hotspot: true },
    }),
    defineField({
      name: "bio",
      title: "О себе",
      type: "text",
      rows: 4,
      description: "Биография, опыт, философия поездок.",
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
      description: "Включите для тестового организатора. Блокирует публичный запуск сайта, пока не будет заменено.",
    }),
  ],
  preview: {
    select: { title: "name", subtitle: "phone", media: "photo" },
  },
});
