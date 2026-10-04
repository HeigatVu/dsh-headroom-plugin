import { resolveConfig } from "./config.mjs";
import { rewriteMessages, stateFor } from "./compress-history.mjs";
import { HeadroomClient } from "./client.mjs";
import { mountHeadroomMcp } from "./mcp.mjs";

export const name = "dsh-headroom";
export const inject = ["agents", "sessions"];

/**
 * Headroom compression for DeepSeek Harness.
 *
 * One job at pre-step: take the batch the waterfall agreed on and hand back
 * the same batch with large, stale history blocks replaced by their
 * Headroom-compressed form (the "from history" path). Everything is fail-open
 * by construction — an unreachable proxy, a malformed answer, or an abort
 * leaves the original decision untouched — and the MCP tool surface is an
 * add-on that must never hold up boot.
 */
export function apply(ctx, input = {}) {
  const config = resolveConfig(input);
  if (!config.enabled) {
    ctx.logger?.debug?.("[dsh-headroom] disabled by config; nothing mounted");
    return;
  }
  const client = new HeadroomClient(config);
  const states = new Map();
  ctx.provide("headroom", { config, client });
  ctx.effect(
    () => () => states.clear(),
    "dshHeadroom.disposeStates()",
  );

  // Per-agent startup: bind the compression cache to the session's lifetime.
  // Runs at most once per agent, whichever DSH event reaches it.
  const started = new WeakSet();
  const startAgent = agent => {
    if (skip(config, agent.session) || started.has(agent)) return;
    started.add(agent);
    const key = String(agent.session?.id || "anonymous");
    agent.ctx.effect(
      () => () => states.delete(key),
      "dshHeadroom.disposeSession()",
    );
  };
  // DSH 0.1.7+ exposes startup as the serial `agent/created` event; older
  // series emit `agent/session-start` alongside. Both are idempotent here.
  ctx.on("agent/created", ({ agent }) => startAgent(agent));
  ctx.on("agent/session-start", ({ agent }) => startAgent(agent));

  // prepend: downstream waterfall listeners run first, so this plugin sees
  // the final claimed batch and rewrites after every other contributor —
  // the same position the OpenViking memory bundle appends from.
  ctx.on("agent/pre-step", async ({ agent, signal }, next) => {
    const decision = await next();
    try {
      if (skip(config, agent.session)) return decision;
      if (decision?.kind !== "enter" || signal?.aborted) return decision;
      if (!config.compressHistory) return decision;
      const state = stateFor(states, agent.session);
      const model = agent.config?.model || config.model;
      const rewrite = await rewriteMessages({
        messages: decision.messages,
        config,
        client,
        cache: state.cache,
        logger: ctx.logger,
        model,
      });
      if (!rewrite) return decision;
      ctx.logger?.debug?.(
        `[dsh-headroom] compressed ${rewrite.compressed} history block(s), saved ~${rewrite.savedTokens} tokens`,
      );
      return { kind: "enter", messages: rewrite.messages };
    } catch (error) {
      // A rewrite must never fail a turn: log and pass the batch through.
      ctx.logger?.warn?.("[dsh-headroom] pre-step rewrite failed, failing open:", error?.message || error);
      return decision;
    }
  }, { prepend: true });

  // Mounted last, and not awaited: the bridge's first tools/list must never
  // delay the registrations above it.
  void mountHeadroomMcp(ctx, config);
}

function skip(config, session) {
  return Boolean(config.skipSubagentSessions && session?.header?.origin === "subagent");
}
