import assert from "node:assert/strict";
import { test } from "node:test";

import {
  contentHash,
  rewriteMessages,
  selectCandidates,
  stateFor,
  textBlocksOf,
} from "./compress-history.mjs";

const config = {
  historyMinChars: 10,
  historyLiveZone: 1,
  historyMaxPerTurn: 8,
  locale: "en",
  model: "deepseek-chat",
};

function message(index, role, text, kind = role === "assistant" ? "model" : "user") {
  return Object.freeze({
    id: `m${index}`,
    role,
    content: [Object.freeze({ type: "text", text })],
    source: Object.freeze({ kind }),
  });
}

function clientAnswering(payload) {
  const calls = [];
  return {
    calls,
    async compressResult(messages, model) {
      calls.push({ messages, model });
      return { ok: true, status: 200, result: payload(messages) };
    },
  };
}

function bigText(seed) {
  return `${seed} ${"word ".repeat(80)}`.trim();
}

test("only first-party user and assistant text blocks are eligible", () => {
  const blocks = textBlocksOf(message(0, "user", "hello world"));
  assert.equal(blocks.length, 1);
  assert.equal(textBlocksOf({ role: "tool", source: { kind: "tool" }, content: [{ type: "text", text: "x".repeat(50) }] }).length, 0);
  assert.equal(textBlocksOf({ role: "user", source: { kind: "plugin:other" }, content: [{ type: "text", text: "x".repeat(50) }] }).length, 0);
  assert.equal(textBlocksOf({ role: "user", source: { kind: "time-context" }, content: [{ type: "text", text: "x".repeat(50) }] }).length, 0);
  assert.equal(textBlocksOf({ role: "user", source: { kind: "user" }, content: [{ type: "image" }] }).length, 0);
  assert.equal(textBlocksOf({ role: "assistant", source: { kind: "model" }, content: [{ type: "text", text: "x".repeat(50) }] }).length, 1);
});

test("the live zone and thresholds bound the candidate set", () => {
  const messages = [
    message(0, "user", bigText("a")),
    message(1, "assistant", "too short"),
    message(2, "user", bigText("b")),
    message(3, "user", bigText("c")),
  ];
  const picks = selectCandidates(messages, config);
  // The last message is inside the live zone; the short assistant turn is
  // filtered; "too short" fails the threshold.
  assert.deepEqual(picks.map(pick => pick.index), [0, 2]);

  const bounded = selectCandidates(messages, { ...config, historyMaxPerTurn: 1 });
  assert.deepEqual(bounded.map(pick => pick.index), [0]);

  const strict = selectCandidates(messages, { ...config, historyMinChars: 10_000 });
  assert.deepEqual(strict, []);
});

test("a rewrite replaces the block, keeps identity, and adds a retrievable marker", async () => {
  const messages = [message(0, "user", bigText("original")), message(1, "user", "tail")];
  const client = clientAnswering(msgs => ({
    messages: msgs.map(entry => ({ role: entry.role, content: `compressed:${entry.content.slice(0, 12)}` })),
    tokens_before: 100,
    tokens_after: 20,
    ccr_hashes: ["abc123"],
  }));
  const cache = new Map();
  const rewrite = await rewriteMessages({ messages, config, client, cache });
  assert.equal(rewrite.compressed, 1);
  assert.equal(rewrite.savedTokens, 80);

  const rewritten = rewrite.messages[0];
  assert.equal(rewritten.id, "m0");
  assert.equal(rewritten.role, "user");
  assert.deepEqual(rewritten.source, { kind: "user" });
  assert.match(rewritten.content[0].text, /^\[headroom\] This content was compressed for the model \(100 → 20 tokens\)\. The original is retrievable with mcp__headroom__headroom_retrieve using hash "abc123"\.\n\n/);
  assert.match(rewritten.content[0].text, /compressed:original/);
  // The tail message is passed through by reference, untouched.
  assert.equal(rewrite.messages[1], messages[1]);
  // The frozen input was never mutated.
  assert.match(messages[0].content[0].text, /^original /);
});

test("the cache makes a rewrite idempotent: the second pass makes no client call", async () => {
  const messages = [message(0, "user", bigText("stable")), message(1, "user", "tail")];
  const client = clientAnswering(msgs => ({
    messages: msgs.map(entry => ({ role: entry.role, content: `compressed:${entry.content.slice(0, 12)}` })),
    tokens_before: 100,
    tokens_after: 20,
    ccr_hashes: ["abc123"],
  }));
  const cache = new Map();
  const first = await rewriteMessages({ messages, config, client, cache });
  const second = await rewriteMessages({ messages, config, client, cache });
  assert.equal(client.calls.length, 1);
  // Byte-identical re-emission keeps the provider prompt cache stable.
  assert.equal(second.messages[0].content[0].text, first.messages[0].content[0].text);
  assert.deepEqual(contentHash(bigText("stable")), contentHash(bigText("stable")));
  assert.notEqual(contentHash(bigText("stable")), contentHash(bigText("other")));
});

test("a no-gain answer is cached as a miss and never rewrites", async () => {
  const messages = [message(0, "user", bigText("dense")), message(1, "user", "tail")];
  const client = clientAnswering(() => ({
    messages: [{ role: "user", content: bigText("dense") }],
    tokens_before: 100,
    tokens_after: 98,
    ccr_hashes: [],
  }));
  const cache = new Map();
  const rewrite = await rewriteMessages({ messages, config, client, cache });
  assert.equal(rewrite, null);
  await rewriteMessages({ messages, config, client, cache });
  assert.equal(client.calls.length, 1, "the miss must not re-send on the next turn");
});

test("every client failure fails open with the original decision untouched", async () => {
  const messages = [message(0, "user", bigText("keep me")), message(1, "user", "tail")];
  const failures = [
    { ok: false, error: "HTTP 500" },
    { ok: false, error: "timeout" },
    { ok: false, error: "compress response misaligned" },
  ];
  for (const failure of failures) {
    const cache = new Map();
    const client = { async compressResult() { return failure; } };
    const rewrite = await rewriteMessages({ messages, config, client, cache });
    assert.equal(rewrite, null, failure.error);
  }
  const throwing = { async compressResult() { throw new Error("socket hung up"); } };
  const cache = new Map();
  const rewrite = await rewriteMessages({ messages, config, client: throwing, cache, logger: { debug() {} } });
  assert.equal(rewrite, null);
  assert.match(messages[0].content[0].text, /^keep me /);
});

test("a malformed answer entry is treated as no gain, not as a crash", async () => {
  const messages = [message(0, "user", bigText("weird")), message(1, "user", "tail")];
  const client = clientAnswering(() => ({
    messages: [{ role: "user", content: { unexpected: "shape" } }],
    tokens_before: 100,
    tokens_after: 2,
    ccr_hashes: [],
  }));
  const rewrite = await rewriteMessages({ messages, config, client, cache: new Map() });
  assert.equal(rewrite, null);
});

test("a missing hash still rewrites with the hashless marker", async () => {
  const messages = [message(0, "user", bigText("no hash")), message(1, "user", "tail")];
  const client = clientAnswering(msgs => ({
    messages: msgs.map(entry => ({ role: entry.role, content: "compressed text here" })),
    tokens_before: 100,
    tokens_after: 20,
    ccr_hashes: [null],
  }));
  const rewrite = await rewriteMessages({ messages, config, client, cache: new Map() });
  assert.equal(rewrite.compressed, 1);
  assert.match(rewrite.messages[0].content[0].text, /^\[headroom\] This content was compressed for the model \(100 → 20 tokens\)\.\n\n/);
});

test("the zh locale renders the zh marker", async () => {
  const messages = [message(0, "user", bigText("中文")), message(1, "user", "tail")];
  const client = clientAnswering(msgs => ({
    messages: msgs.map(entry => ({ role: entry.role, content: "压缩后的内容" })),
    tokens_before: 100,
    tokens_after: 20,
    ccr_hashes: ["zz"],
  }));
  const rewrite = await rewriteMessages({ messages, config: { ...config, locale: "zh" }, client, cache: new Map() });
  assert.match(rewrite.messages[0].content[0].text, /^\[headroom\] 此内容已为模型压缩（100 → 20 tokens）/);
});

test("session state caches are isolated per session", () => {
  const states = new Map();
  const first = stateFor(states, { id: "s1" });
  const again = stateFor(states, { id: "s1" });
  const other = stateFor(states, { id: "s2" });
  assert.equal(first, again);
  assert.notEqual(first, other);
  assert.equal(first.cache instanceof Map, true);
});
