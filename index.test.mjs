import assert from "node:assert/strict";
import { test } from "node:test";

import { apply } from "./index.mjs";

function fakeCtx() {
  const state = { handlers: {}, effects: [], provided: {}, plugins: [], warnings: [] };
  return {
    state,
    on(event, handler, opts) { (state.handlers[event] ||= []).push({ handler, opts }); },
    provide(name, value) { state.provided[name] = value; },
    effect(fn, label) { state.effects.push({ fn, label }); },
    plugin(module, config) { state.plugins.push({ module, config }); return { mounted: true }; },
    logger: {
      debug() {},
      info() {},
      warn(...args) { state.warnings.push(args.join(" ")); },
    },
  };
}

function fakeAgent(overrides = {}) {
  const effects = [];
  return {
    session: { id: "s1", header: overrides.header || {} },
    config: { model: "deepseek-flash" },
    ctx: { effect(fn, label) { effects.push({ fn, label }); } },
    effects,
  };
}

function bigMessage(index, text) {
  return Object.freeze({
    id: `m${index}`,
    role: "user",
    content: [Object.freeze({ type: "text", text })],
    source: Object.freeze({ kind: "user" }),
  });
}

const bigText = seed => `${seed} ${"word ".repeat(850)}`.trim();

function wiredStub(ctx, answer) {
  // The plugin publishes its client through ctx.provide; the suite stubs the
  // same surface a real Headroom proxy would answer.
  const client = ctx.state.provided.headroom.client;
  client.compressResult = async messages => answer(messages);
  return client;
}

function pluginInput(overrides = {}) {
  return { mcpEnabled: false, ...overrides };
}

test("apply registers the pre-step listener and publishes the client", () => {
  const ctx = fakeCtx();
  apply(ctx, pluginInput());
  assert.ok(ctx.state.handlers["agent/pre-step"]);
  assert.equal(ctx.state.handlers["agent/pre-step"][0].opts.prepend, true);
  assert.equal(ctx.state.provided.headroom.config.enabled, true);
  assert.equal(ctx.state.provided.headroom.config.proxyUrl, "http://127.0.0.1:8787");
});

test("a disabled config mounts nothing", () => {
  const ctx = fakeCtx();
  apply(ctx, { enabled: false });
  assert.equal(ctx.state.handlers["agent/pre-step"], undefined);
  assert.equal(ctx.state.provided.headroom, undefined);
});

test("a successful rewrite returns the compressed batch", async () => {
  const ctx = fakeCtx();
  apply(ctx, pluginInput());
  wiredStub(ctx, messages => ({
    ok: true,
    result: {
      messages: messages.map(entry => ({ role: entry.role, content: "compressed" })),
      tokens_before: 500,
      tokens_after: 50,
      ccr_hashes: ["ff00"],
    },
  }));
  const handler = ctx.state.handlers["agent/pre-step"][0].handler;
  const agent = fakeAgent();
  const decision = {
    kind: "enter",
    messages: [
      bigMessage(0, bigText("old")),
      bigMessage(1, "middle"),
      bigMessage(2, "recent a"),
      bigMessage(3, "recent b"),
      bigMessage(4, "recent c"),
      bigMessage(5, "tail"),
    ],
  };
  const result = await handler({ agent, signal: undefined }, async () => decision);
  assert.equal(result.kind, "enter");
  assert.match(result.messages[0].content[0].text, /^\[headroom\]/);
  // The live zone — the newest four messages — is passed through untouched.
  assert.equal(result.messages[1], decision.messages[1]);
  assert.equal(result.messages[2], decision.messages[2]);
  assert.equal(result.messages[3], decision.messages[3]);
  assert.equal(result.messages[4], decision.messages[4]);
  assert.equal(result.messages[5], decision.messages[5]);
});

test("a failing proxy leaves the original decision byte-identical", async () => {
  const ctx = fakeCtx();
  apply(ctx, pluginInput());
  wiredStub(ctx, async () => ({ ok: false, error: "HTTP 503" }));
  const handler = ctx.state.handlers["agent/pre-step"][0].handler;
  const agent = fakeAgent();
  const decision = { kind: "enter", messages: [bigMessage(0, bigText("old")), bigMessage(1, "tail")] };
  const result = await handler({ agent, signal: undefined }, async () => decision);
  assert.equal(result, decision, "the exact decision object must pass through");
});

test("non-enter decisions, aborts, and subagent sessions are never rewritten", async () => {
  const ctx = fakeCtx();
  apply(ctx, pluginInput());
  const client = wiredStub(ctx, () => ({ ok: false, error: "must not be called" }));
  let called = 0;
  const counting = client.compressResult;
  client.compressResult = async (...args) => { called += 1; return counting(...args); };

  const handler = ctx.state.handlers["agent/pre-step"][0].handler;
  const decision = { kind: "enter", messages: [bigMessage(0, bigText("old"))] };

  const nonEnter = await handler(
    { agent: fakeAgent(), signal: undefined },
    async () => ({ kind: "skip", messages: [] }),
  );
  assert.equal(nonEnter.kind, "skip");

  const aborted = new AbortController();
  aborted.abort();
  const abortedResult = await handler(
    { agent: fakeAgent(), signal: aborted.signal },
    async () => decision,
  );
  assert.equal(abortedResult, decision);

  const subagent = await handler(
    { agent: fakeAgent({ header: { origin: "subagent" } }), signal: undefined },
    async () => decision,
  );
  assert.equal(subagent, decision);

  assert.equal(called, 0, "no proxy call may fire on any skip path");
});

test("a throwing rewrite is contained: the decision still passes through", async () => {
  const ctx = fakeCtx();
  apply(ctx, pluginInput());
  const client = ctx.state.provided.headroom.client;
  client.compressResult = async () => { throw new Error("socket hung up"); };
  const handler = ctx.state.handlers["agent/pre-step"][0].handler;
  const decision = { kind: "enter", messages: [bigMessage(0, bigText("old"))] };
  const result = await handler({ agent: fakeAgent(), signal: undefined }, async () => decision);
  assert.equal(result, decision);
});

test("compression can be turned off without losing the tool surface wiring", async () => {
  const ctx = fakeCtx();
  apply(ctx, pluginInput({ compressHistory: false }));
  const handler = ctx.state.handlers["agent/pre-step"][0].handler;
  const decision = { kind: "enter", messages: [bigMessage(0, bigText("old"))] };
  const result = await handler({ agent: fakeAgent(), signal: undefined }, async () => decision);
  assert.equal(result, decision);
});

test("session caches dispose with their agent", async () => {
  const ctx = fakeCtx();
  apply(ctx, pluginInput());
  const handler = ctx.state.handlers["agent/pre-step"][0].handler;
  const agent = fakeAgent();
  // Startup binds the cache lifetime: whichever event fires first registers
  // the per-agent dispose effect.
  ctx.state.handlers["agent/created"][0].handler({ agent });
  wiredStub(ctx, messages => ({
    ok: true,
    result: {
      messages: messages.map(entry => ({ role: entry.role, content: "compressed" })),
      tokens_before: 100,
      tokens_after: 10,
      ccr_hashes: [],
    },
  }));
  const decision = { kind: "enter", messages: [bigMessage(0, bigText("old")), bigMessage(1, "tail")] };
  await handler({ agent, signal: undefined }, async () => decision);
  // The per-agent effect bound the cache lifetime to the session.
  const agentEffect = agent.effects.at(-1);
  assert.match(agentEffect.label, /disposeSession/);
  agentEffect.fn();
});

test("the MCP peer being unavailable is a contained warning, not a crash", async () => {
  const ctx = fakeCtx();
  apply(ctx, pluginInput({ mcpEnabled: true }));
  // The dynamic import of the dsh-mcp-client peer fails in this checkout (no
  // host fallback under node --test); await the microtask queue it runs on.
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(ctx.state.plugins.length, 0);
  assert.ok(ctx.state.warnings.some(w => w.includes("dsh-mcp-client peer unavailable")));
});
