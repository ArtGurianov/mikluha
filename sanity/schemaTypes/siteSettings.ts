import { defineField, defineType } from "sanity";

export const siteSettings = defineType({
  name: "siteSettings",
  title: "Настройки сайта",
  type: "document",
  groups: [
    { name: "general", title: "Общее", default: true },
    { name: "hero", title: "Главный экран" },
    { name: "booking", title: "Бронирование" },
    { name: "company", title: "Реквизиты" },
    { name: "seo", title: "SEO" },
    { name: "release", title: "Готовность к запуску" },
  ],
  fields: [
    defineField({
      name: "siteName",
      title: "Название сайта / бренда",
      type: "string",
      group: "general",
      initialValue: "Миклуха Маклай",
      validation: (rule) => rule.required(),
    }),
    defineField({
      name: "siteUrl",
      title: "Адрес сайта",
      type: "url",
      group: "general",
      description: "Используется для canonical-ссылок и sitemap.xml, например https://miklukha-maklay.ru",
      validation: (rule) => rule.required(),
    }),
    defineField({
      name: "timezone",
      title: "Часовой пояс",
      type: "string",
      group: "general",
      description: "Используется для расчёта ближайшего выезда во время сборки сайта, например Europe/Moscow",
      initialValue: "Europe/Moscow",
      validation: (rule) => rule.required(),
    }),
    defineField({
      name: "logo",
      title: "Логотип",
      type: "image",
      group: "general",
    }),
    defineField({
      name: "favicon",
      title: "Favicon",
      type: "image",
      group: "general",
      description: "Опционально: если не задан, используется логотип.",
    }),
    defineField({
      name: "hero",
      title: "Главный экран (Hero)",
      type: "object",
      group: "hero",
      fields: [
        defineField({ name: "title", title: "Заголовок", type: "string", validation: (rule) => rule.required() }),
        defineField({ name: "subtitle", title: "Подзаголовок", type: "text", rows: 2 }),
        defineField({
          name: "image",
          title: "Фоновое изображение",
          type: "image",
          options: { hotspot: true },
          validation: (rule) => rule.required(),
        }),
      ],
    }),
    defineField({
      name: "booking",
      title: "Бронирование по умолчанию",
      type: "object",
      group: "booking",
      description:
        "Значения по умолчанию для Booking Modal, если у конкретного выезда не заданы свои QR / сумма / организатор.",
      fields: [
        defineField({ name: "defaultQr", title: "QR-код по умолчанию", type: "image" }),
        defineField({ name: "defaultPrepaymentAmount", title: "Сумма предоплаты по умолчанию, ₽", type: "number" }),
        defineField({
          name: "defaultOrganizer",
          title: "Организатор по умолчанию",
          type: "reference",
          to: [{ type: "organizer" }],
        }),
        defineField({
          name: "isDemo",
          title: "Демо-данные (тест)",
          type: "boolean",
          initialValue: false,
          description: "Включите, пока QR/сумма/организатор по умолчанию тестовые.",
        }),
      ],
    }),
    defineField({
      name: "socials",
      title: "Соцсети и мессенджеры",
      type: "object",
      group: "general",
      fields: [
        defineField({
          name: "maxChannelUrl",
          title: "Ссылка на канал MAX",
          type: "url",
          description: "Опционально. Отображается вне Booking Modal, например в Footer.",
        }),
      ],
    }),
    defineField({
      name: "company",
      title: "Реквизиты организации",
      type: "object",
      group: "company",
      fields: [
        defineField({ name: "legalName", title: "Название / ФИО ИП", type: "string", validation: (rule) => rule.required() }),
        defineField({ name: "inn", title: "ИНН", type: "string", validation: (rule) => rule.required() }),
        defineField({ name: "ogrn", title: "ОГРН", type: "string", validation: (rule) => rule.required() }),
        defineField({ name: "phone", title: "Телефон компании", type: "string", validation: (rule) => rule.required() }),
        defineField({ name: "email", title: "Email", type: "string" }),
        defineField({
          name: "isDemo",
          title: "Демо-данные (тест)",
          type: "boolean",
          initialValue: false,
          description: "Включите, пока реквизиты тестовые. Блокирует публичный запуск сайта.",
        }),
      ],
    }),
    defineField({
      name: "seo",
      title: "SEO по умолчанию",
      type: "object",
      group: "seo",
      fields: [
        defineField({ name: "title", title: "Заголовок сайта (title)", type: "string", validation: (rule) => rule.required() }),
        defineField({ name: "description", title: "Описание сайта", type: "text", rows: 2, validation: (rule) => rule.required() }),
        defineField({ name: "ogImage", title: "OG-изображение по умолчанию", type: "image" }),
      ],
    }),
    defineField({
      name: "launchReady",
      title: "Сайт готов к публичному запуску",
      type: "boolean",
      group: "release",
      initialValue: false,
      description:
        "Включайте только после того, как все реквизиты, контакты, QR и отзывы заменены на реальные (см. памятку организатора).",
    }),
  ],
  preview: {
    select: { title: "siteName", launchReady: "launchReady" },
    prepare({ title, launchReady }) {
      return {
        title: title || "Настройки сайта",
        subtitle: launchReady ? "Готов к запуску" : "Не готов к запуску (демо-режим)",
      };
    },
  },
});
