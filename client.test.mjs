import assert from "node:assert/strict";
import { test } from "node:test";

import { HeadroomClient } from "./client.mjs";

const baseConfig = { proxyUrl: "http://127.0.0.1:8787", requestTimeoutMs: 200, model: "deepseek-chat" };

function fetchOk(body) {
  return async () => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });
}

test("health and retrieve hit the documented paths", async () => {
  const calls = [];
  const client = new HeadroomClient(baseConfig, async (url, init) => {
    calls.push([url, init]);
    return { ok: true, status: 200, text: async () => JSON.stringify({ status: "healthy" }) };
  });
  const health = await client.healthResult();
  assert.equal(health.ok, true);
  const retrieve = await client.retrieveResult("abc/123");
  assert.equal(retrieve.ok, true);
  assert.equal(calls[0][0], "http://127.0.0.1:8787/health");
  assert.equal(calls[1][0], "http://127.0.0.1:8787/v1/retrieve/abc%2F123");
});

test("compress posts messages and answers the aligned payload", async () => {
  const calls = [];
  const client = new HeadroomClient(baseConfig, async (url, init) => {
    calls.push([url, init]);
    return fetchOk({
      messages: [{ role: "user", content: "short" }],
      tokens_before: 10,
      tokens_after: 5,
      ccr_hashes: ["deadbeef"],
    })(url, init);
  });
  const result = await client.compressResult([{ role: "user", content: "long" }]);
  assert.equal(result.ok, true);
  assert.deepEqual(result.result.ccr_hashes, ["deadbeef"]);
  const [url, init] = calls[0];
  assert.equal(url, "http://127.0.0.1:8787/v1/compress");
  assert.deepEqual(JSON.parse(init.body).messages, [{ role: "user", content: "long" }]);
  assert.equal(JSON.parse(init.body).model, "deepseek-chat");
});

test("a misaligned compress response is a typed failure, not a rewrite hazard", async () => {
  const client = new HeadroomClient(baseConfig, fetchOk({ messages: [], tokens_before: 1, tokens_after: 1 }));
  const result = await client.compressResult([{ role: "user", content: "long" }]);
  assert.equal(result.ok, false);
  assert.equal(result.error, "compress response misaligned");
});

test("every failure mode is fail-open: HTTP error, malformed JSON, timeout, connection refused", async () => {
  const httpError = new HeadroomClient(baseConfig, async () => ({ ok: false, status: 500, text: async () => "" }));
  assert.deepEqual((await httpError.compressResult([{ role: "user", content: "x" }])).ok, false);

  const badJson = new HeadroomClient(baseConfig, async () => ({ ok: true, status: 200, text: async () => "<html>" }));
  const malformed = await badJson.healthResult();
  assert.equal(malformed.ok, false);
  assert.equal(malformed.error, "malformed JSON");

  const timeout = new HeadroomClient(baseConfig, async (url, init) => {
    // Honor the caller's abort signal the way fetch would on a deadline.
    return new Promise((resolve, reject) => {
      init.signal.addEventListener("abort", () => {
        const error = new Error("The operation was aborted due to timeout");
        error.name = "TimeoutError";
        reject(error);
      });
    });
  });
  const timedOut = await timeout.healthResult();
  assert.equal(timedOut.ok, false);
  assert.equal(timedOut.error, "timeout");

  const refused = new HeadroomClient(baseConfig, async () => {
    const error = new Error("connect ECONNREFUSED");
    throw error;
  });
  const down = await refused.healthResult();
  assert.equal(down.ok, false);
  assert.match(down.error, /ECONNREFUSED/);
});

test("requests never outlive the configured timeout budget", async () => {
  let seenSignal = null;
  const client = new HeadroomClient(baseConfig, async (url, init) => {
    seenSignal = init.signal;
    return { ok: true, status: 200, text: async () => "{}" };
  });
  await client.healthResult();
  assert.ok(seenSignal instanceof AbortSignal);
  assert.equal(seenSignal.aborted, false);
});
