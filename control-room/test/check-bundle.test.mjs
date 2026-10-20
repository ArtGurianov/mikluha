import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { findings } from "../scripts/check-bundle.mjs";

test("the bundle check refuses credentials and server configuration", () => {
  const dir = mkdtempSync(join(tmpdir(), "cr-bundle-"));
  mkdirSync(join(dir, "_next"));
  writeFileSync(join(dir, "index.html"), "<p>Control Room</p>");
  assert.deepEqual(findings(dir), []);
  const leaks = {
    "a.js": 'const u="postgres://admin:pw@db/mikluha"',
    "b.js": "process.env.ADMIN_TOTP_KEY",
    "publisher.js": "process.env.ADMIN_PUBLISH_DATABASE_URL",
    "audit.js": "process.env.ADMIN_AUDIT_KEY",
    "previous.js": "process.env.ADMIN_AUDIT_PREVIOUS_KEYS",
    "c.js": `t="ghp_${"a".repeat(36)}"`,
    "d.js": "k='AKIAABCDEFGHIJKLMNOP'",
    "e.js": "-----BEGIN OPENSSH PRIVATE KEY-----",
  };
  for (const [name, text] of Object.entries(leaks)) writeFileSync(join(dir, "_next", name), text);
  assert.equal(findings(dir).length, Object.keys(leaks).length);
});
