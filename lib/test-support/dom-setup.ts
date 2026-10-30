// Import before react-dom/client: React detects input-event support when its module loads.
import { JSDOM } from "jsdom";

export const dom = new JSDOM("<!doctype html><html><head></head><body></body></html>", { url: "https://ui.example.invalid" });
Object.assign(globalThis, {
  window: dom.window, self: dom.window, document: dom.window.document,
  FormData: dom.window.FormData,
  requestAnimationFrame: (callback: () => void) => setTimeout(callback, 0),
  IS_REACT_ACT_ENVIRONMENT: true,
});
