import assert from "node:assert/strict";
import test from "node:test";

import { assertImageSource, assertVideoSource } from "./asset-source";

test("baked media uses tracked site or demo files", () => {
  assert.doesNotThrow(() => assertImageSource("/media/site/mikluha-thumbnail.webp"));
  assert.doesNotThrow(() => assertVideoSource("/media/site/mikluha.webm"));
  assert.doesNotThrow(() => assertImageSource("/media/demo/brand-logo.webp"));
  assert.throws(() => assertImageSource("https://media.example.test/hero.webp"), /tracked/);
  assert.throws(() => assertImageSource("/media/site/../private.webp"), /tracked/);
  assert.throws(() => assertVideoSource("/media/site/mikluha.webp"), /WebM/);
});
