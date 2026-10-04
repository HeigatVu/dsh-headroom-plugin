export const PLUGIN_VERSION = "0.1.0";

/**
 * Namespace for the bridged Headroom MCP tools. DSH publishes every MCP tool
 * as `mcp__<serverName>__<rawName>`, so this string is part of the
 * model-facing contract: changing it renames all of them.
 */
export const MCP_SERVER_NAME = "headroom";

export const DEFAULTS = Object.freeze({
  enabled: true,
  proxyUrl: "http://127.0.0.1:8787",
  // The from-history path: compress large, stale outbound history at pre-step.
  compressHistory: true,
  historyMinChars: 4000,
  historyLiveZone: 4,
  historyMaxPerTurn: 8,
  // Model hint the compress endpoint routes on; the agent's own model wins.
  model: "deepseek-chat",
  locale: "en",
  mcpEnabled: true,
  mcpCommand: "headroom",
  mcpToolCallTimeoutMs: 15000,
  requestTimeoutMs: 8000,
  skipSubagentSessions: true,
  debug: false,
});

/**
 * Resolve the plugin's configuration.
 *
 * `input` is what the cordis host hands the plugin — the `config` block of the
 * `id: dsh-headroom` entry in the profile's cordis.patch.yml. The host input
 * wins over environment variables, which win over the defaults, because the
 * patch is the most specific statement of this profile's intent.
 */
export function resolveConfig(input = {}, env = process.env) {
  if (env.HEADROOM_DSH_DISABLED === "1" || env.HEADROOM_DSH_DISABLED === "true") {
    return { ...DEFAULTS, ...sanitize(input), enabled: false };
  }
  const envOverrides = {};
  if (env.HEADROOM_PROXY_URL) envOverrides.proxyUrl = env.HEADROOM_PROXY_URL;
  if (env.HEADROOM_DSH_COMPRESS_HISTORY === "0") envOverrides.compressHistory = false;
  if (env.HEADROOM_DSH_MCP === "0") envOverrides.mcpEnabled = false;
  return { ...DEFAULTS, ...envOverrides, ...sanitize(input) };
}

/**
 * Drop unknown keys and coerce the knobs the patch layer may hand us as
 * strings, so a YAML typo degrades to the default instead of disabling the
 * safety bounds silently.
 */
function sanitize(input) {
  const clean = {};
  for (const key of Object.keys(DEFAULTS)) {
    if (!(key in input)) continue;
    clean[key] = coerce(key, input[key]);
  }
  if (typeof clean.proxyUrl === "string" && clean.proxyUrl.endsWith("/")) {
    clean.proxyUrl = clean.proxyUrl.slice(0, -1);
  }
  return clean;
}

function coerce(key, value) {
  const kind = typeof DEFAULTS[key];
  if (kind === "boolean") {
    if (typeof value === "string") return value === "true" || value === "1";
    return Boolean(value);
  }
  if (kind === "number") {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return DEFAULTS[key];
    // A negative or zero live zone would rewrite the message the model is
    // about to answer; a negative threshold would rewrite everything.
    const minimum = key === "historyLiveZone" ? 1 : key === "historyMinChars" ? 1 : 0;
    return parsed < minimum ? DEFAULTS[key] : parsed;
  }
  return typeof value === "string" ? value : DEFAULTS[key];
}
