import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";

// Every script must print help and exit 0 on --help, with no network access or credentials.
for (const f of readdirSync(new URL("../scripts/", import.meta.url)).filter((f) => f.endsWith(".mjs"))) {
  test(`${f} --help`, () => {
    const out = execFileSync(process.execPath, [`scripts/${f}`, "--help"], { encoding: "utf8", timeout: 20000, env: { ...process.env, GOOGLE_APPLICATION_CREDENTIALS: "/nonexistent" } });
    assert.ok(out.trim().length > 40, "help text too short");
  });
}
