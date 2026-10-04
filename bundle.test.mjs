import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { test } from "node:test";

import * as bundle from "./index.mjs";

test("the bundle exports the contract the cordis loader consumes", () => {
  assert.equal(bundle.name, "dsh-headroom");
  assert.deepEqual(bundle.inject, ["agents", "sessions"]);
  assert.equal(typeof bundle.apply, "function");
});

test("every module parses as an ES module", () => {
  const modules = readdirSync(new URL(".", import.meta.url).pathname)
    .filter(name => name.endsWith(".mjs") && !name.endsWith(".test.mjs"));
  assert.ok(modules.includes("index.mjs"));
  for (const name of modules) {
    execFileSync(process.execPath, ["--check", new URL(`./${name}`, import.meta.url).pathname]);
  }
});
