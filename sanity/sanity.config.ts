import { visionTool } from "@sanity/vision";
import { defineConfig } from "sanity";
import { structureTool } from "sanity/structure";

import { apiVersion, dataset, projectId } from "./env";
import { schemaTypes } from "./schemaTypes";
import { structure } from "./structure";

export default defineConfig({
  name: "miklukha-maklay",
  title: "Миклуха Маклай — админка",

  projectId,
  dataset,

  plugins: [structureTool({ structure }), visionTool({ defaultApiVersion: apiVersion })],

  schema: {
    types: schemaTypes,
    templates: (templates) =>
      templates.filter((template) => template.schemaType !== "siteSettings"),
  },

  document: {
    newDocumentOptions: (prev, { creationContext }) => {
      if (creationContext.type === "global") {
        return prev.filter((template) => template.templateId !== "siteSettings");
      }
      return prev;
    },
    actions: (prev, { schemaType }) => {
      if (schemaType === "siteSettings") {
        return prev.filter(
          (action) => !["duplicate", "delete", "unpublish"].includes(action.action ?? ""),
        );
      }
      return prev;
    },
  },
});
