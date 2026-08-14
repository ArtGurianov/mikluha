import { defineField, defineType } from "sanity";

export const departure = defineType({
  name: "departure",
  title: "Выезд",
  type: "document",
  groups: [
    { name: "content", title: "Даты и статус", default: true },
    { name: "booking", title: "Оплата" },
    { name: "system", title: "Технические поля" },
  ],
  fields: [
    defineField({
      name: "tour",
      title: "Направление",
      type: "reference",
      to: [{ type: "tour" }],
      group: "content",
      validation: (rule) => rule.required(),
    }),
    defineField({
      name: "startDate",
      title: "Дата начала",
      type: "date",
      group: "content",
      options: { dateFormat: "DD.MM.YYYY" },
      validation: (rule) => rule.required(),
    }),
    defineField({
      name: "endDate",
      title: "Дата окончания",
      type: "date",
      group: "content",
      options: { dateFormat: "DD.MM.YYYY" },
      validation: (rule) =>
        rule.required().min(rule.valueOfField("startDate")),
    }),
    defineField({
      name: "bookingStatus",
      title: "Статус набора",
      type: "string",
      group: "content",
      options: {
        list: [
          { title: "Набор открыт", value: "OPEN" },
          { title: "Набор закрыт", value: "CLOSED" },
          { title: "Поездка отменена", value: "CANCELLED" },
        ],
        layout: "radio",
      },
      initialValue: "OPEN",
      validation: (rule) => rule.required(),
    }),
    defineField({
      name: "price",
      title: "Стоимость поездки, ₽",
      type: "number",
      group: "booking",
      description:
        "Цена за одного человека, целое число рублей. Задаётся для каждого выезда отдельно — " +
        "одно и то же направление в разные даты может стоить по-разному. Показывается крупно " +
        "на карточке поездки. Обязательна, если набор открыт.",
      validation: (rule) =>
        rule
          .integer()
          .positive()
          .custom((value, context) => {
            const status = (context.document as { bookingStatus?: string } | undefined)?.bookingStatus;
            if (status === "OPEN" && value === undefined) {
              return "Укажите стоимость — выезд с открытым набором не может быть опубликован без цены";
            }
            return true;
          }),
    }),
    defineField({
      name: "prepaymentAmount",
      title: "Сумма предоплаты, ₽",
      type: "number",
      group: "booking",
      description:
        "Если не заполнено, используется значение по умолчанию из «Настроек сайта».",
    }),
    defineField({
      name: "paymentQr",
      title: "QR-код предоплаты",
      type: "image",
      group: "booking",
      description:
        "Если не загружен, используется QR по умолчанию из «Настроек сайта».",
    }),
    defineField({
      name: "organizers",
      title: "Организаторы",
      type: "array",
      group: "booking",
      of: [{ type: "reference", to: [{ type: "organizer" }] }],
      description:
        "Если список пуст, используется организатор по умолчанию из «Настроек сайта».",
    }),
    defineField({
      name: "isListed",
      title: "Показывать на сайте",
      type: "boolean",
      group: "system",
      initialValue: true,
    }),
    defineField({
      name: "isDemo",
      title: "Демо-данные (тест)",
      type: "boolean",
      group: "system",
      initialValue: false,
      description:
        "Включите для тестовых выездов. Такие выезды блокируют публичный запуск сайта, пока не будут заменены.",
    }),
  ],
  orderings: [
    {
      title: "Дата начала (сначала новые)",
      name: "startDateDesc",
      by: [{ field: "startDate", direction: "desc" }],
    },
  ],
  preview: {
    select: {
      tourTitle: "tour.title",
      startDate: "startDate",
      endDate: "endDate",
      status: "bookingStatus",
      media: "tour.coverImage",
    },
    prepare({ tourTitle, startDate, endDate, status, media }) {
      const statusLabel =
        status === "OPEN"
          ? "Набор открыт"
          : status === "CLOSED"
            ? "Набор закрыт"
            : "Отменена";
      return {
        title: tourTitle ? `${tourTitle}: ${startDate ?? "?"} — ${endDate ?? "?"}` : "Выезд без направления",
        subtitle: statusLabel,
        media,
      };
    },
  },
});
