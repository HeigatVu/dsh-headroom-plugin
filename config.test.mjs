import assert from "node:assert/strict";
import { test } from "node:test";

import { DEFAULTS, MCP_SERVER_NAME, resolveConfig } from "./config.mjs";

test("defaults apply when no input is given", () => {
  const config = resolveConfig({}, {});
  for (const key of Object.keys(DEFAULTS)) {
    assert.equal(config[key], DEFAULTS[key], key);
  }
  assert.equal(config.proxyUrl, "http://127.0.0.1:8787");
  assert.equal(MCP_SERVER_NAME, "headroom");
});

test("host input wins over environment, environment wins over defaults", () => {
  const fromEnv = resolveConfig({}, { HEADROOM_PROXY_URL: "http://127.0.0.1:9999" });
  assert.equal(fromEnv.proxyUrl, "http://127.0.0.1:9999");

  const hostWins = resolveConfig(
    { proxyUrl: "http://127.0.0.1:7777" },
    { HEADROOM_PROXY_URL: "http://127.0.0.1:9999" },
  );
  assert.equal(hostWins.proxyUrl, "http://127.0.0.1:7777");
});

test("HEADROOM_DSH_DISABLED wins over an enabled patch", () => {
  const config = resolveConfig({ enabled: true }, { HEADROOM_DSH_DISABLED: "1" });
  assert.equal(config.enabled, false);
});

test("unknown keys are dropped and booleans coerce from patch strings", () => {
  const config = resolveConfig(
    { enabled: "true", compressHistory: "0", notAKey: "drop me", proxyUrl: "http://127.0.0.1:8787/" },
    {},
  );
  assert.equal(config.enabled, true);
  assert.equal(config.compressHistory, false);
  assert.equal("notAKey" in config, false);
  assert.equal(config.proxyUrl, "http://127.0.0.1:8787");
});

test("numeric bounds fall back to defaults instead of disabling safety", () => {
  assert.equal(resolveConfig({ historyLiveZone: 0 }, {}).historyLiveZone, DEFAULTS.historyLiveZone);
  assert.equal(resolveConfig({ historyLiveZone: -3 }, {}).historyLiveZone, DEFAULTS.historyLiveZone);
  assert.equal(resolveConfig({ historyMinChars: -1 }, {}).historyMinChars, DEFAULTS.historyMinChars);
  assert.equal(resolveConfig({ historyMinChars: 2000 }, {}).historyMinChars, 2000);
  assert.equal(resolveConfig({ historyLiveZone: 8 }, {}).historyLiveZone, 8);
});
