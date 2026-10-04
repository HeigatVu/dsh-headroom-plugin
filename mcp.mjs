import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { MCP_SERVER_NAME } from "./config.mjs";

/**
 * Mount the Headroom tool surface. The bridge ships with dsh itself, so the
 * peer import resolves from the host installation at boot and never needs a
 * separate install step. The import is dynamic and injectable: a missing peer
 * or a dead binary is contained here as a logged skip, because the tool
 * surface is an add-on to compression, never a boot dependency.
 *
 * Mounted last, and deliberately not awaited: the bridge's apply blocks on
 * its first tools/list, so a server that accepts the connection but never
 * answers would otherwise hold up every registration above it.
 */
export async function mountHeadroomMcp(ctx, config, importPeer) {
  if (!config.mcpEnabled) return null;
  const command = resolveHeadroomCommand(config.mcpCommand);
  if (!command) {
    ctx.logger?.warn?.("[dsh-headroom] headroom binary not found; MCP tools not mounted");
    return null;
  }
  let mcpClient;
  try {
    mcpClient = await (importPeer || (spec => import(spec)))("@deepseek-ai/dsh-mcp-client");
  } catch (error) {
    ctx.logger?.warn?.(
      "[dsh-headroom] dsh-mcp-client peer unavailable; MCP tools not mounted:",
      error?.message || error,
    );
    return null;
  }
  try {
    return ctx.plugin(mcpClient, buildMcpConfig(config, command));
  } catch (error) {
    ctx.logger?.warn?.("[dsh-headroom] MCP mount failed; continuing without tools:", error?.message || error);
    return null;
  }
}

export function buildMcpConfig(config, command) {
  return {
    transport: "stdio",
    serverName: MCP_SERVER_NAME,
    command,
    args: ["mcp", "serve", "--proxy-url", config.proxyUrl],
    toolCallTimeoutMs: config.mcpToolCallTimeoutMs,
  };
}

/**
 * Resolve the Headroom CLI. DSH scrubs the environment its children inherit
 * and the systemd service runs with a narrow PATH, so a bare command name is
 * only the last resort: well-known install locations are probed first, and a
 * configured absolute path (with `~` expanded) always wins.
 */
export function resolveHeadroomCommand(configured, exists = existsSync) {
  if (configured && configured.includes("/")) {
    const expanded = configured.startsWith("~")
      ? join(homedir(), configured.slice(1))
      : configured;
    return exists(expanded) ? expanded : null;
  }
  const candidates = [
    process.env.HEADROOM_BIN,
    join(homedir(), ".local/bin/headroom"),
    "/usr/local/bin/headroom",
    "/usr/bin/headroom",
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (exists(candidate)) return candidate;
  }
  // Fall through to PATH resolution by the child's own launcher.
  return configured || null;
}
