import type { StructureResolver } from "sanity/structure";

export const structure: StructureResolver = (S) =>
  S.list()
    .title("Миклуха Маклай")
    .items([
      S.listItem()
        .title("Настройки сайта")
        .id("siteSettings")
        .child(
          S.document()
            .schemaType("siteSettings")
            .documentId("siteSettings")
            .title("Настройки сайта"),
        ),
      S.divider(),
      S.documentTypeListItem("tour").title("Туры"),
      S.documentTypeListItem("departure")
        .title("Выезды")
        .child(
          S.documentTypeList("departure")
            .title("Выезды")
            .defaultOrdering([{ field: "startDate", direction: "desc" }]),
        ),
      S.documentTypeListItem("report").title("Отчёты"),
      S.documentTypeListItem("review").title("Отзывы"),
      S.documentTypeListItem("organizer").title("Организаторы"),
      S.documentTypeListItem("legalPage").title("Правовые страницы"),
    ]);
