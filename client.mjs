/**
 * Loopback HTTP client for the local Headroom proxy.
 *
 * Every method answers a typed result instead of throwing: the plugin is
 * fail-open by design, and a dead or misbehaving proxy must degrade to "no
 * compression", never to a broken agent turn. The fetch implementation is
 * injectable so the unit suite runs without a network.
 */
export class HeadroomClient {
  constructor(config, fetchImpl = globalThis.fetch.bind(globalThis)) {
    this.config = config;
    this.fetchImpl = fetchImpl;
  }

  async healthResult() {
    return this.request("/health", { method: "GET" });
  }

  /**
   * Compress a batch of wire-shaped messages `{role, content}` through the
   * proxy. The response mirrors the request's messages array one-to-one; a
   * response that does not preserve length is answered as a failure so the
   * caller can fail open on the whole batch rather than mis-align a rewrite.
   */
  async compressResult(messages, model = this.config.model) {
    const expected = messages.length;
    const result = await this.request("/v1/compress", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, messages }),
    });
    if (!result.ok) return result;
    const answered = result.result?.messages;
    if (!Array.isArray(answered) || answered.length !== expected) {
      return { ok: false, error: "compress response misaligned", status: result.status };
    }
    return result;
  }

  async retrieveResult(hash) {
    return this.request(`/v1/retrieve/${encodeURIComponent(String(hash))}`, { method: "GET" });
  }

  async request(path, init) {
    try {
      const response = await this.fetchImpl(`${this.config.proxyUrl}${path}`, {
        ...init,
        signal: AbortSignal.timeout(this.config.requestTimeoutMs),
      });
      if (!response.ok) {
        return { ok: false, error: `HTTP ${response.status}`, status: response.status };
      }
      const text = await response.text();
      try {
        return { ok: true, status: response.status, result: JSON.parse(text) };
      } catch {
        return { ok: false, error: "malformed JSON", status: response.status };
      }
    } catch (error) {
      return {
        ok: false,
        error: error?.name === "TimeoutError" ? "timeout" : String(error?.message || error),
      };
    }
  }
}
