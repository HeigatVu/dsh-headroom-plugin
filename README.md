# Headroom Compression for DeepSeek Harness

An installable DeepSeek Harness bundle that compresses large, stale conversation
history through the local [Headroom](https://github.com/headroomlabs-ai/headroom)
proxy before it reaches the model, and mounts the Headroom MCP tool surface
(`headroom_compress`, `headroom_retrieve`, `headroom_stats`).

> **Requires a running Headroom proxy** (default `http://127.0.0.1:8787`,
> installed with `headroom install apply --preset persistent-service` or
> `headroom proxy`). With the proxy down the plugin fails open: sessions run
> uncompressed, nothing breaks.

## What it does

- **From-history compression** — at each `agent/pre-step`, text blocks from
  first-party user and assistant turns older than the live zone and larger than
  `historyMinChars` are replaced with their Headroom-compressed form plus a
  marker naming the CCR hash. The model can recover any original with
  `mcp__headroom__headroom_retrieve`. A per-session content-hash cache sends
  each block to the proxy at most once, keeping the outbound prompt tail
  byte-stable across turns so DeepSeek's provider prompt cache survives.
- **MCP tool surface** — mounts `headroom mcp serve` over stdio via DSH's
  MCP bridge, exposing `mcp__headroom__headroom_compress`,
  `mcp__headroom__headroom_retrieve`, and `mcp__headroom__headroom_stats`.
- **Fail-open containment** — every Headroom failure (proxy down, timeout,
  malformed answer) leaves the original decision untouched; the stored session
  transcript is never rewritten, only the outbound view.

Modeled on [`@openviking/dsh-memory-plugin`](https://github.com/volcengine/OpenViking/tree/main/examples/dsh-memory-plugin);
shares its bundle anatomy, hook positions, and containment rules.

## Install

This repository is the standalone source of the plugin. Inside a DSH home checkout it lives at `plugins/dsh-headroom/`; install it into a profile either from a GitHub checkout:

```bash
dsh plugin --profile web add github:HeigatVu/dsh-headroom-plugin
```

or from a local path (this workspace's layout):

```bash
dsh plugin --profile web add ../../plugins/dsh-headroom   # from a profile dir; any path to this checkout
dsh --profile web --dump-config                            # should list @ducvu/dsh-headroom-plugin
systemctl --user restart deepseek-harness                  # boot the web profile service
```

The bundle has no runtime npm dependencies; the MCP bridge comes from DSH's own
`@deepseek-ai/dsh-mcp-client` peer, resolved from the host installation at boot.

## Configuration

Set via the profile's `cordis.patch.yml`:

```yaml
- id: dsh-headroom
  name: "@ducvu/dsh-headroom-plugin"
  config:
    enabled: true
    proxyUrl: http://127.0.0.1:8787
    compressHistory: true
    historyMinChars: 4000     # only blocks at least this long are candidates
    historyLiveZone: 4        # never rewrite the newest 4 messages of the batch
    historyMaxPerTurn: 8      # at most 8 blocks compressed per turn
    mcpEnabled: true
    mcpCommand: headroom      # absolute path, or a name resolved from known install locations
    skipSubagentSessions: true
```

`HEADROOM_PROXY_URL`, `HEADROOM_DSH_DISABLED=1`, `HEADROOM_DSH_COMPRESS_HISTORY=0`
and `HEADROOM_DSH_MCP=0` override from the environment; the patch input wins.

## Development

```bash
npm test    # node --test, no network: the HTTP client is injected as a stub
npm run check
```
