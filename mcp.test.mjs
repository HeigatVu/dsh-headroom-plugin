import { homedir } from "node:os";
import { join } from "node:path";

import assert from "node:assert/strict";
import { test } from "node:test";

import { buildMcpConfig, mountHeadroomMcp, resolveHeadroomCommand } from "./mcp.mjs";

const config = {
  mcpEnabled: true,
  mcpCommand: "headroom",
  mcpToolCallTimeoutMs: 5000,
  proxyUrl: "http://127.0.0.1:8787",
};

function fakeCtx() {
  const state = { plugins: [], warnings: [] };
  return {
    state,
    plugin(module, config) { state.plugins.push({ module, config }); return { mounted: true }; },
    logger: { warn(...args) { state.warnings.push(args.join(" ")); }, debug() {} },
  };
}

test("the stdio config points at `headroom mcp serve` under the headroom server name", () => {
  const built = buildMcpConfig(config, "/usr/local/bin/headroom");
  assert.equal(built.transport, "stdio");
  assert.equal(built.serverName, "headroom");
  assert.equal(built.command, "/usr/local/bin/headroom");
  assert.deepEqual(built.args, ["mcp", "serve", "--proxy-url", "http://127.0.0.1:8787"]);
  assert.equal(built.toolCallTimeoutMs, 5000);
});

test("command resolution probes well-known locations before falling back to PATH", () => {
  const existing = new Set(["/home/u/.local/bin/headroom"]);
  const exists = path => existing.has(path);
  // Nothing on disk and no PATH hope: the bare name is still returned and the
  // spawn failure lands in the bridge's own containment.
  assert.equal(resolveHeadroomCommand("headroom", exists), "headroom");
  assert.equal(resolveHeadroomCommand("/opt/headroom/bin/headroom", exists), null);
  assert.equal(resolveHeadroomCommand("/opt/headroom/bin/headroom", path => path === "/opt/headroom/bin/headroom"), "/opt/headroom/bin/headroom");
  assert.equal(resolveHeadroomCommand("~/bin/headroom", path => path === join(homedir(), "bin/headroom")), join(homedir(), "bin/headroom"));
  assert.equal(resolveHeadroomCommand(undefined, () => false), null);
  // A bare name with no candidate on disk still resolves through the child's
  // own PATH lookup rather than being rejected outright.
  assert.equal(resolveHeadroomCommand("headroom", () => false), "headroom");
});

test("a disabled flag mounts nothing and imports no peer", async () => {
  const ctx = fakeCtx();
  let imported = false;
  const result = await mountHeadroomMcp(ctx, { ...config, mcpEnabled: false }, async () => { imported = true; });
  assert.equal(result, null);
  assert.equal(imported, false);
  assert.equal(ctx.state.plugins.length, 0);
});

test("a successful mount hands the bridge module and config to ctx.plugin", async () => {
  const ctx = fakeCtx();
  const bridgeModule = { name: "dsh-mcp-client-stub" };
  const result = await mountHeadroomMcp(ctx, config, async () => bridgeModule);
  assert.deepEqual(result, { mounted: true });
  assert.equal(ctx.state.plugins[0].module, bridgeModule);
  assert.equal(ctx.state.plugins[0].config.serverName, "headroom");
});

test("an unavailable peer is a contained skip", async () => {
  const ctx = fakeCtx();
  const result = await mountHeadroomMcp(ctx, config, async () => { throw new Error("Cannot find package"); });
  assert.equal(result, null);
  assert.equal(ctx.state.plugins.length, 0);
  assert.ok(ctx.state.warnings.some(w => w.includes("peer unavailable")));
});

test("a throwing ctx.plugin is contained too", async () => {
  const ctx = fakeCtx();
  ctx.plugin = () => { throw new Error("bridge exploded"); };
  const result = await mountHeadroomMcp(ctx, config, async () => ({ name: "stub" }));
  assert.equal(result, null);
  assert.ok(ctx.state.warnings.some(w => w.includes("MCP mount failed")));
});
