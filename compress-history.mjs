import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * From-history compression.
 *
 * Rewrites the outbound LLM view of the conversation: large, stale text
 * blocks are replaced with their Headroom-compressed form plus a marker that
 * names the CCR hash, so the model can recover the original through
 * `mcp__headroom__headroom_retrieve`. The session's stored transcript is
 * never touched — only the message list this plugin hands back from the
 * `agent/pre-step` waterfall.
 *
 * A per-session cache keyed by the sha256 of the original text makes the
 * rewrite idempotent and prefix-stable: a given message is sent to the proxy
 * at most once, and every later turn re-emits the same compressed bytes, so
 * DeepSeek's provider prompt cache sees a stable tail.
 */

/** Source kinds this plugin never rewrites: tool results and system prompts. */
const IMMUTABLE_SOURCE_KINDS = new Set(["tool", "system-prompt"]);

export function stateFor(states, session) {
  const key = String(session?.id || "anonymous");
  let state = states.get(key);
  if (!state) {
    state = { cache: new Map(), key };
    states.set(key, state);
  }
  return state;
}

export function textBlocksOf(message) {
  if (!message || typeof message !== "object") return [];
  if (message.role !== "user" && message.role !== "assistant") return [];
  const source = message.source;
  if (!source) return [];
  if (IMMUTABLE_SOURCE_KINDS.has(source.kind)) return [];
  // Only first-party turns are eligible. Producer context declares its own
  // kind (plugin:, time-context, recall, ...), and rewriting another
  // producer's block could break that producer's own resume dedup.
  if (message.role === "user" && source.kind !== "user") return [];
  if (message.role === "assistant" && source.kind !== "model") return [];
  return message.content.filter(
    block => block?.type === "text" && typeof block.text === "string",
  );
}

export function selectCandidates(messages, config) {
  const liveZone = Math.max(1, config.historyLiveZone);
  const budget = Math.max(0, config.historyMaxPerTurn);
  const cutoff = messages.length - liveZone;
  const picks = [];
  for (let index = 0; index < cutoff && picks.length < budget; index += 1) {
    const blocks = textBlocksOf(messages[index]);
    for (const block of blocks) {
      if (block.text.length >= config.historyMinChars) {
        picks.push({ index, block });
        break;
      }
    }
  }
  return picks;
}

export function contentHash(text) {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

/**
 * Rewrite the batch. Returns `null` when nothing changed (no candidates, a
 * cache pass with no gains, or any client failure); otherwise a report with a
 * new message array whose selected blocks are replaced. The input array and
 * its messages are frozen — every replacement builds a shallow clone with a
 * new content array, keeping each message's identity, role, and source.
 */
export async function rewriteMessages({
  messages,
  config,
  client,
  cache,
  logger = console,
  model,
}) {
  const candidates = selectCandidates(messages, config);
  if (candidates.length === 0) return null;

  const resolved = new Map();
  const pending = [];
  for (const pick of candidates) {
    const hash = contentHash(pick.block.text);
    if (cache.has(hash)) {
      // A cached miss ("checked, no gain") keeps the original bytes without
      // paying for a second proxy round-trip on every later turn.
      const cached = cache.get(hash);
      if (cached) resolved.set(pick, cached);
    } else {
      pending.push({ pick, hash });
    }
  }

  if (pending.length > 0) {
    let result;
    try {
      result = await client.compressResult(
        pending.map(entry => ({
          role: roleOf(messages[entry.pick.index]),
          content: entry.pick.block.text,
        })),
        model,
      );
    } catch (error) {
      // A throwing client is the same fail-open as a typed failure: the
      // caller gets the original batch, never an exception.
      logger.debug?.("[dsh-headroom] compress threw, failing open:", error?.message || error);
      return null;
    }
    if (!result.ok) {
      logger.debug?.("[dsh-headroom] compress failed, failing open:", result.error);
      return null;
    }
    collectGains(pending, result.result, cache, resolved);
  }

  if (resolved.size === 0) return null;

  const newMessages = [...messages];
  for (const [pick, entry] of resolved) {
    const original = pick.block;
    const rewritten = { ...original, text: `${markerText(entry, config.locale)}${entry.text}` };
    newMessages[pick.index] = {
      ...messages[pick.index],
      content: messages[pick.index].content.map(block => (block === original ? rewritten : block)),
    };
  }
  return {
    messages: newMessages,
    compressed: resolved.size,
    savedTokens: sumSaved(resolved),
  };
}

/**
 * Fold one compress response into the cache and the resolved set. A message
 * only counts as gained when the proxy returned shorter text for a smaller
 * token count; anything else is cached as a miss so later turns skip it.
 */
function collectGains(pending, payload, cache, resolved) {
  const answered = Array.isArray(payload?.messages) ? payload.messages : [];
  const hashes = Array.isArray(payload?.ccr_hashes) ? payload.ccr_hashes : [];
  const tokensBefore = Number(payload?.tokens_before);
  const tokensAfter = Number(payload?.tokens_after);
  const counted = Number.isFinite(tokensBefore)
    && Number.isFinite(tokensAfter)
    && tokensAfter < tokensBefore;
  for (let i = 0; i < pending.length; i += 1) {
    const { pick, hash } = pending[i];
    const compressed = typeof answered[i]?.content === "string" ? answered[i].content : null;
    const gained = counted && compressed !== null && compressed.length < pick.block.text.length;
    const entry = gained
      ? {
          text: compressed,
          hash: typeof hashes[i] === "string" && hashes[i] ? hashes[i] : null,
          tokensBefore,
          tokensAfter,
        }
      : null;
    cache.set(hash, entry);
    if (entry) resolved.set(pick, entry);
  }
}

function roleOf(message) {
  return message?.role === "assistant" ? "assistant" : "user";
}

function markerText(entry, locale) {
  const strings = loadLocale(locale);
  const template = entry.hash ? strings.markerWithHash : strings.markerNoHash;
  return template
    .replaceAll("{before}", String(entry.tokensBefore))
    .replaceAll("{after}", String(entry.tokensAfter))
    .replaceAll("{hash}", entry.hash || "");
}

const localeCache = new Map();

function loadLocale(name) {
  const key = name || "en";
  if (!localeCache.has(key)) {
    try {
      const path = fileURLToPath(new URL(`./locale/${key}.json`, import.meta.url));
      localeCache.set(key, JSON.parse(readFileSync(path, "utf8")));
    } catch {
      // An unknown locale falls back to the bundled English strings; the
      // marker is informational and must never break a rewrite.
      localeCache.set(key, loadLocale("en"));
    }
  }
  return localeCache.get(key);
}

function sumSaved(resolved) {
  let saved = 0;
  for (const entry of resolved.values()) {
    saved += Math.max(0, (entry.tokensBefore || 0) - (entry.tokensAfter || 0));
  }
  return saved;
}
